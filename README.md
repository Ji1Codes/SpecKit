# Calculator Web App (FastAPI)

This is a small **calculator webpage** where the UI runs in the browser, but the actual math is evaluated by a **Python FastAPI backend**.

## How it works (simple story)

1. Your browser opens [`static/index.html`](static/index.html:1).
2. When you press `=`, JavaScript sends your expression to the backend endpoint `POST /api/calc`.
3. The backend parses your text into a Python AST (a tree of operations) and evaluates **only safe arithmetic** (no variables, no function calls).
4. The backend returns a JSON response containing the result.

## Run it

### 1) Install deps

If you have a virtualenv already:

```bat
python -m pip install -r requirements.txt
```

### 2) Start the server

```bat
python -m uvicorn app:app --reload
```

Open:

- http://127.0.0.1:8000/

## Files

- Backend: [`app.py`](app.py:1)
- Frontend:
  - [`static/index.html`](static/index.html:1)
  - [`static/styles.css`](static/styles.css:1)
  - [`static/app.js`](static/app.js:1)
