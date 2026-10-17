"""The MCP client, ported from src/mcp-client.mjs, exercised against fake
servers: a stdio server script and a loopback HTTP server. No network."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jevlang._mcp import (META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_VERSION,
                          SUPPORTED_VERSIONS, handle_message, make_mcp_conn, make_mcp_server,
                          mcp_input_required, mcp_text_result, mcp_tool)
from jevlang._mcp_client import (McpClientError, mcp_call_tool, mcp_close, mcp_connect,
                                 mcp_handlers, mcp_list_tools, mcp_request, mcp_result_text,
                                 param_headers_problem)

HERE = os.path.dirname(__file__)

FAKE_SERVER = r'''
"""A minimal modern MCP stdio server: server/discover, tools/list, tools/call."""
import json
import sys

TOOLS = [
    {"name": "lock-door", "inputSchema": {"type": "object", "properties": {
        "door": {"type": "string", "x-mcp-header": "door"}}}},
    {"name": "bad-headers", "inputSchema": {"type": "object", "properties": {
        "x": {"type": "number", "x-mcp-header": "x"}}}},
    {"name": "asks", "inputSchema": {"type": "object"}},
]

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    if msg.get("id") is None or method is None:
        continue
    meta = (msg.get("params") or {}).get("_meta") or {}
    version = meta.get("io.modelcontextprotocol/protocolVersion")
    if method == "server/discover":
        result = {"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {}},
                  "_meta": {"io.modelcontextprotocol/serverInfo": {"name": "fake", "version": "0"}}}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name = (msg.get("params") or {}).get("name")
        if name == "lock-door":
            result = {"content": [{"type": "text", "text": "locked"}], "isError": False}
        elif name == "asks":
            result = {"resultType": "input_required",
                      "inputRequests": {"q": {"method": "elicitation/create",
                                              "params": {"message": "Which room?"}}}}
        else:
            result = {"content": [{"type": "text", "text": "unknown"}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                     "error": {"code": -32601, "message": "nope"}}) + "\n")
        sys.stdout.flush()
        continue
    out = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
    if version:
        result["resultType"] = result.get("resultType", "complete")
        result["_meta"] = {"io.modelcontextprotocol/serverInfo": {"name": "fake", "version": "0"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''

LEGACY_SERVER = r'''
"""A legacy initialize-only MCP stdio server."""
import json
import sys

era = None
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    if msg.get("id") is None or method is None:
        continue
    if method == "initialize":
        era = True
        result = {"protocolVersion": "2025-06-18", "capabilities": {},
                  "serverInfo": {"name": "legacy", "version": "0"}}
    elif method == "tools/list" and era:
        result = {"tools": [{"name": "old-tool", "inputSchema": {"type": "object"}}]}
    elif method == "ping":
        result = {}
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                     "error": {"code": -32601, "message": "nope"}}) + "\n")
        sys.stdout.flush()
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
'''


def fake_server_path(source: str) -> str:
    fd, path = tempfile.mkstemp(suffix='.py')
    with os.fdopen(fd, 'w') as handle:
        handle.write(source)
    return path


class StdioTests(unittest.TestCase):
    def setUp(self):
        self.paths = []

    def tearDown(self):
        for path in self.paths:
            os.unlink(path)

    def _server(self, source: str) -> list:
        path = fake_server_path(source)
        self.paths.append(path)
        return [sys.executable, path]

    def test_probe_connects_to_a_modern_server(self):
        async def run():
            client = await mcp_connect(self._server(FAKE_SERVER), timeout_seconds=10)
            try:
                self.assertEqual(client['era'], 'modern')
                self.assertEqual(client['serverInfo']['name'], 'fake')
                tools = await mcp_list_tools(client)
                self.assertEqual([t['name'] for t in tools], ['lock-door', 'bad-headers', 'asks'])
                result = await mcp_call_tool(client, 'lock-door', {'door': 'front'})
                self.assertEqual(mcp_result_text(result), 'locked')
            finally:
                await mcp_close(client)

        asyncio.run(run())

    def test_a_legacy_server_is_reached_through_initialize(self):
        async def run():
            client = await mcp_connect(self._server(LEGACY_SERVER), timeout_seconds=10)
            try:
                self.assertEqual(client['era'], 'legacy')
                self.assertEqual(client['version'], '2025-06-18')
                tools = await mcp_list_tools(client)
                self.assertEqual([t['name'] for t in tools], ['old-tool'])
            finally:
                await mcp_close(client)

        asyncio.run(run())

    def test_a_missing_program_is_a_connection_error(self):
        async def run():
            with self.assertRaises(McpClientError) as raised:
                await mcp_connect(['/no/such/program-xyz'], timeout_seconds=5)
            self.assertEqual(raised.exception.kind, 'connection')
            self.assertIn('no program named', str(raised.exception))

        asyncio.run(run())

    def test_a_timeout_is_reported(self):
        silent = "import sys, time; time.sleep(60)\n"
        async def run():
            client = await mcp_connect(self._server(silent), timeout_seconds=10,
                                       probe_timeout_seconds=0.3)
        with self.assertRaises(McpClientError) as raised:
            asyncio.run(run())
        self.assertEqual(raised.exception.kind, 'timeout')

    def test_handlers_map_tools_and_ask_is_refused(self):
        async def run():
            client = await mcp_connect(self._server(FAKE_SERVER), timeout_seconds=10)
            try:
                handlers = await mcp_handlers(client, only=['lock-door', 'asks'])
                self.assertEqual(list(handlers.keys()), ['lock-door', 'asks'])
                self.assertEqual(handlers['lock-door'].handlerName, 'lock-door')
                outcome = await handlers['lock-door']({}, {'data': {'door': 'front'}})
                self.assertEqual(outcome, [{'type': 'text', 'text': 'locked'}])
                # A dispatcher cannot answer a person's questions.
                with self.assertRaises(McpClientError) as raised:
                    await handlers['asks']({}, {'data': {}})
                self.assertIn('asked for more input', str(raised.exception))
                # A tool error result comes back for the model to read.
                failed = await mcp_call_tool(client, 'unknown-tool', {})
                self.assertTrue(failed['isError'])
                with self.assertRaises(McpClientError) as missing:
                    await mcp_handlers(client, only=['nope'])
                self.assertIn('has no tool named nope', str(missing.exception))
            finally:
                await mcp_close(client)

        asyncio.run(run())


class HttpTests(unittest.TestCase):
    def start(self, responder):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length) or b'{}')
                answer = responder(self, body)
                if answer is None:
                    self.send_response(500)
                    self.end_headers()
                    return
                payload = json.dumps(answer).encode('utf8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return f'http://127.0.0.1:{server.server_address[1]}/mcp'

    def test_a_modern_http_server(self):
        def responder(handler, body):
            method = body.get('method')
            if method == 'server/discover':
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': {'supportedVersions': SUPPORTED_VERSIONS,
                                   'capabilities': {'tools': {}},
                                   '_meta': {'io.modelcontextprotocol/serverInfo':
                                             {'name': 'http-fake', 'version': '0'}}}}
            if method == 'tools/list':
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': {'tools': [{'name': 't', 'inputSchema': {
                            'type': 'object', 'properties': {
                                'q': {'type': 'string', 'x-mcp-header': 'q'}}}}],
                            'resultType': 'complete'}}
            if method == 'tools/call':
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': {'content': [{'type': 'text', 'text': 'ok'}],
                                   'isError': False, 'resultType': 'complete'}}
            return None

        async def run():
            url = self.start(responder)
            client = await mcp_connect(url, timeout_seconds=10)
            try:
                self.assertEqual((client['era'], client['kind']), ('modern', 'http'))
                tools = await mcp_list_tools(client)
                self.assertEqual([t['name'] for t in tools], ['t'])
                result = await mcp_call_tool(client, 't', {'q': 'hello'})
                self.assertEqual(mcp_result_text(result), 'ok')
            finally:
                await mcp_close(client)

        asyncio.run(run())

    def test_a_legacy_http_server_falls_back_to_initialize(self):
        def responder(handler, body):
            method = body.get('method')
            if body.get('id') is None:
                return {'jsonrpc': '2.0', 'result': {}}
            if method == 'initialize':
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': {'protocolVersion': '2025-06-18', 'capabilities': {},
                                   'serverInfo': {'name': 'legacy', 'version': '0'}}}
            if method == 'tools/list':
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': {'tools': [{'name': 'old', 'inputSchema': {'type': 'object'}}]}}
            return {'jsonrpc': '2.0', 'id': body['id'],
                    'error': {'code': -32601, 'message': 'nope'}}

        async def run():
            url = self.start(responder)
            client = await mcp_connect(url, timeout_seconds=10)
            try:
                self.assertEqual(client['era'], 'legacy')
                tools = await mcp_list_tools(client)
                self.assertEqual([t['name'] for t in tools], ['old'])
            finally:
                await mcp_close(client)

        asyncio.run(run())


class PureTests(unittest.TestCase):
    def test_param_headers_rules(self):
        self.assertIsNone(param_headers_problem(
            {'type': 'object', 'properties': {'q': {'type': 'string', 'x-mcp-header': 'q'}}}))
        self.assertIn('somewhere other than a chain of properties',
                      param_headers_problem({'x-mcp-header': 'x'}))
        self.assertIn('not a header-name token',
                      param_headers_problem({'type': 'object', 'properties': {
                          'q': {'type': 'string', 'x-mcp-header': 'bad name'}}}))
        self.assertIn('the same',
                      param_headers_problem({'type': 'object', 'properties': {
                          'a': {'type': 'string', 'x-mcp-header': 'X'},
                          'b': {'type': 'string', 'x-mcp-header': 'x'}}}))
        self.assertIn('only for string, integer and boolean',
                      param_headers_problem({'type': 'object', 'properties': {
                          'n': {'type': 'number', 'x-mcp-header': 'n'}}}))


if __name__ == '__main__':
    unittest.main()
