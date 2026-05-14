const exprInput = document.getElementById('expression');
const resultEl = document.getElementById('result');
const errorEl = document.getElementById('error');

function setError(msg) {
  errorEl.textContent = msg || '\u00a0';
}

function setResult(msg) {
  resultEl.textContent = msg || '\u00a0';
}

function insertText(text) {
  const start = exprInput.selectionStart ?? exprInput.value.length;
  const end = exprInput.selectionEnd ?? exprInput.value.length;
  const before = exprInput.value.slice(0, start);
  const after = exprInput.value.slice(end);
  exprInput.value = before + text + after;
  const caret = start + text.length;
  exprInput.setSelectionRange(caret, caret);
  exprInput.focus();
}

function backspace() {
  const start = exprInput.selectionStart ?? exprInput.value.length;
  const end = exprInput.selectionEnd ?? exprInput.value.length;

  if (start !== end) {
    // delete selection
    const before = exprInput.value.slice(0, start);
    const after = exprInput.value.slice(end);
    exprInput.value = before + after;
    exprInput.setSelectionRange(start, start);
    exprInput.focus();
    return;
  }

  if (start === 0) return;

  const before = exprInput.value.slice(0, start - 1);
  const after = exprInput.value.slice(start);
  exprInput.value = before + after;
  const caret = start - 1;
  exprInput.setSelectionRange(caret, caret);
  exprInput.focus();
}

function clearAll() {
  exprInput.value = '';
  setResult('');
  setError('');
  exprInput.focus();
}

async function evaluateExpression() {
  const expression = exprInput.value.trim();
  if (!expression) {
    setError('Type something to calculate');
    setResult('');
    return;
  }

  setError('');
  setResult('Calculating...');

  try {
    const res = await fetch('/api/calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression }),
    });

    if (!res.ok) {
      // FastAPI sends {detail: "..."} for HTTPException
      const data = await res.json().catch(() => ({}));
      const msg = data.detail || 'Invalid expression';
      setResult('');
      setError(msg);
      return;
    }

    const data = await res.json();
    if (data.ok) {
      setResult(String(data.result));
      setError('');
    } else {
      setResult('');
      setError(data.error || 'Error');
    }
  } catch (e) {
    setResult('');
    setError('Network error: could not reach backend');
  }
}

// Button handling
for (const btn of document.querySelectorAll('button[data-insert]')) {
  btn.addEventListener('click', () => {
    setError('');
    insertText(btn.getAttribute('data-insert'));
  });
}

for (const btn of document.querySelectorAll('button[data-action]')) {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-action');
    if (action === 'clear') return clearAll();
    if (action === 'back') return backspace();
    if (action === 'equals') return evaluateExpression();
  });
}

// Keyboard shortcuts
exprInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    evaluateExpression();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    clearAll();
  }
});

// Initial focus
exprInput.focus();
