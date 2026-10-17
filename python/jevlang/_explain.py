"""One decision in prose: what it decided, which clause, and what it read.

The portable mirror of src/explain.mjs; the mcp, gate, webhook and serve
layers all quote decisions through it, so the bytes are the contract."""
from __future__ import annotations

from typing import Any

from ._numberfmt import js_number_str, jsonify


def _value(v: Any) -> str:
    return v if isinstance(v, str) else jsonify(v)


def explain_decision(d: dict) -> str:
    head = (f"{d.get('action')}"
            + (f" {d.get('target')}" if d.get('target') else '')
            + (f"  // {d.get('reason')}" if d.get('reason') else ''))
    where = ''
    if d.get('rule'):
        where = (f"\n  {d.get('rule')}"
                 + ('' if d.get('clause') is None else f" {js_number_str(d.get('clause')) if isinstance(d.get('clause'), float) else d.get('clause')}")
                 + (f", {d.get('source')}" if d.get('source') else ''))
    readings = d.get('readings') or []
    because = ''
    if readings:
        lines = []
        for r in readings:
            line = f"    {r.get('question')} = {_value(r.get('value'))}"
            if r.get('confidence') is not None:
                line += f"   confidence {r.get('confidence')}"
            if r.get('detail'):
                line += f"   ({r.get('detail')})"
            lines.append(line)
        because = '\n  because\n' + '\n'.join(lines)
    return f"{head}{where}{because}"
