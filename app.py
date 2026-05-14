from __future__ import annotations

import ast
import operator as op
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


# -----------------------------------------------------------------------------
# Story of how this app works (end-to-end)
# -----------------------------------------------------------------------------
# Step 1: The browser opens the calculator page
#   - GET / returns the static HTML page (static/index.html)
# Step 2: You click buttons (or type) to build an expression like: 12*(3+4)
# Step 3: When you press "=", the browser calls the backend
#   - POST /api/calc with JSON: {"expression": "12*(3+4)"}
# Step 4: The backend evaluates the expression safely
#   - We DO NOT use eval(). We parse into an AST and allow only arithmetic nodes.
# Step 5: The backend returns JSON
#   - {"ok": true, "result": 84.0}
#   - or {"ok": false, "error": "..."}

app = FastAPI(title="Calculator")

# Serve files under ./static at /static
app.mount("/static", StaticFiles(directory="static"), name="static")


# ---
# Safe expression evaluator
# ---

_ALLOWED_BIN_OPS: dict[type, Any] = {
    ast.Add: op.add,
    ast.Sub: op.sub,
    ast.Mult: op.mul,
    ast.Div: op.truediv,
    ast.Mod: op.mod,
    ast.Pow: op.pow,
}

_ALLOWED_UNARY_OPS: dict[type, Any] = {
    ast.UAdd: op.pos,
    ast.USub: op.neg,
}


@dataclass(frozen=True)
class CalcError(Exception):
    message: str


def _eval_ast(node: ast.AST) -> float:
    """Evaluate a restricted arithmetic AST and return a float.

    Allowed:
      - numbers
      - +, -, *, /, %, **
      - unary + and -
      - parentheses (naturally represented by the AST)

    Rejected:
      - names (like x)
      - function calls (like sqrt(9))
      - attributes, subscripts, comprehensions, etc.
    """

    if isinstance(node, ast.Expression):
        return _eval_ast(node.body)

    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)

    if isinstance(node, ast.Num):  # pragma: no cover
        return float(node.n)

    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in _ALLOWED_BIN_OPS:
            raise CalcError(f"Operator not allowed: {op_type.__name__}")
        left = _eval_ast(node.left)
        right = _eval_ast(node.right)
        try:
            return float(_ALLOWED_BIN_OPS[op_type](left, right))
        except ZeroDivisionError:
            raise CalcError("Division by zero")

    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in _ALLOWED_UNARY_OPS:
            raise CalcError(f"Unary operator not allowed: {op_type.__name__}")
        operand = _eval_ast(node.operand)
        return float(_ALLOWED_UNARY_OPS[op_type](operand))

    raise CalcError(f"Invalid expression element: {type(node).__name__}")


def calculate(expression: str) -> float:
    expr = (expression or "").strip()
    if not expr:
        raise CalcError("Expression is empty")

    if len(expr) > 200:
        raise CalcError("Expression too long")

    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        raise CalcError("Invalid syntax")

    return _eval_ast(tree)


# ---
# API models
# ---


class CalcRequest(BaseModel):
    expression: str


class CalcResponse(BaseModel):
    ok: bool
    result: float | None = None
    error: str | None = None


# ---
# Routes
# ---


@app.get("/")
def index() -> FileResponse:
    # Serve the UI.
    return FileResponse("static/index.html")


@app.post("/api/calc", response_model=CalcResponse)
def api_calc(body: CalcRequest) -> CalcResponse:
    try:
        result = calculate(body.expression)
        return CalcResponse(ok=True, result=result)
    except CalcError as e:
        # 400 means: the client sent something invalid (bad expression).
        raise HTTPException(status_code=400, detail=e.message)