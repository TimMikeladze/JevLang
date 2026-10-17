"""Small cancellable asyncio HTTP/1.1 client for the TypeSafe JSON API."""
import asyncio
import ssl
from urllib.parse import urlsplit
from ._common import require_at
from ._assets import MAX_REQUEST_BYTES


async def request_http(url, method, headers, body=None, timeout=None):
    parsed = urlsplit(url)
    require_at(parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password, 'baseUrl', 'expected an HTTP(S) URL without embedded credentials')
    async def exchange():
        writer = None
        try:
            context = ssl.create_default_context() if parsed.scheme == 'https' else None
            reader, writer = await asyncio.open_connection(parsed.hostname, parsed.port or (443 if context else 80), ssl=context, server_hostname=parsed.hostname if context else None)
            path = (parsed.path or '/') + ('?' + parsed.query if parsed.query else '')
            require_at('\r' not in path and '\n' not in path, 'baseUrl', 'invalid request path')
            head = {'Host': parsed.netloc, 'Connection': 'close', **headers}
            if body is not None: head['Content-Length'] = str(len(body))
            writer.write((f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in head.items()) + '\r\n').encode('latin1'))
            if body is not None: writer.write(body)
            await writer.drain()
            while True:
                status_line = await reader.readline()
                fields = status_line.decode('latin1').split(' ', 2)
                require_at(len(fields) >= 2 and fields[0].startswith('HTTP/') and fields[1].isdigit(), 'response', 'invalid HTTP status line', code='response')
                status, returned, count = int(fields[1]), {}, len(status_line)
                while True:
                    line = await reader.readline(); count += len(line)
                    require_at(count <= 65536, 'response', 'HTTP headers exceed 64 KiB', code='response')
                    if line == b'\r\n': break
                    require_at(line and b':' in line, 'response', 'incomplete HTTP headers', code='response')
                    key, value = line.decode('latin1').split(':', 1)
                    returned[key.lower()] = value.strip()
                if not 100 <= status < 200: break
            chunks, size = [], 0
            if returned.get('transfer-encoding', '').lower() == 'chunked':
                while True:
                    line = await reader.readline()
                    try: length = int(line.split(b';')[0].strip(), 16)
                    except ValueError: raise ValueError('invalid HTTP chunk length')
                    require_at(length >= 0 and size + length <= MAX_REQUEST_BYTES, 'response', 'HTTP body exceeds 32 MiB', code='response')
                    if length == 0: break
                    chunks.append(await reader.readexactly(length)); size += length
                    require_at(await reader.readexactly(2) == b'\r\n', 'response', 'invalid HTTP chunk framing', code='response')
            elif 'content-length' in returned:
                length = int(returned['content-length'])
                require_at(0 <= length <= MAX_REQUEST_BYTES, 'response', 'HTTP body exceeds 32 MiB', code='response')
                chunks.append(await reader.readexactly(length))
            else:
                while True:
                    chunk = await reader.read(65536)
                    if not chunk: break
                    size += len(chunk)
                    require_at(size <= MAX_REQUEST_BYTES, 'response', 'HTTP body exceeds 32 MiB', code='response')
                    chunks.append(chunk)
            return status, returned, b''.join(chunks)
        finally:
            if writer is not None:
                writer.close()
                try: await asyncio.wait_for(writer.wait_closed(), .2)
                except (Exception, asyncio.CancelledError): pass
    return await asyncio.wait_for(exchange(), timeout) if timeout else await exchange()
