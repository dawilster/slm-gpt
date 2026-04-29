# perf_kv responses — label: baseline

- model: `qwen3-4b-instruct-2507`
- loaded context: 8196
- timestamp: 20260428T233353
- needle: `BANANA-CARNIVAL-9417`

Each request placed the needle near the start of the prompt, followed by
filler, then the question. Filler is omitted from this file (it's repetitive
"this is filler line N" lines); see the JSON sidecar for raw metrics.

---

## requested 1024 tokens (actual prompt_tokens=1055)

- ttft: 9850 ms
- total: 10171 ms
- gen tok/s: 37.4
- completion tokens: 12
- needle recalled: ✓

**preamble (sent first):**

```
IMPORTANT BACKGROUND FACT: The codeword for today is "BANANA-CARNIVAL-9417". Remember this exact codeword. What follows is unrelated filler context.
```

**question (sent last):**

```
End of filler. Question: what was the exact codeword given at the very beginning of this message? Reply with just the codeword and nothing else.
```

**model reply:**

```
BANANA-CARNIVAL-9417
```

---

## requested 2048 tokens (actual prompt_tokens=2167)

- ttft: 11616 ms
- total: 11987 ms
- gen tok/s: 32.3
- completion tokens: 12
- needle recalled: ✓

**preamble (sent first):**

```
IMPORTANT BACKGROUND FACT: The codeword for today is "BANANA-CARNIVAL-9417". Remember this exact codeword. What follows is unrelated filler context.
```

**question (sent last):**

```
End of filler. Question: what was the exact codeword given at the very beginning of this message? Reply with just the codeword and nothing else.
```

**model reply:**

```
BANANA-CARNIVAL-9417
```

---

## requested 4096 tokens (actual prompt_tokens=4467)

- ttft: 25280 ms
- total: 25730 ms
- gen tok/s: 26.7
- completion tokens: 12
- needle recalled: ✓

**preamble (sent first):**

```
IMPORTANT BACKGROUND FACT: The codeword for today is "BANANA-CARNIVAL-9417". Remember this exact codeword. What follows is unrelated filler context.
```

**question (sent last):**

```
End of filler. Question: what was the exact codeword given at the very beginning of this message? Reply with just the codeword and nothing else.
```

**model reply:**

```
BANANA-CARNIVAL-9417
```

---

## requested 6144 tokens (actual prompt_tokens=6747)

- ttft: 28485 ms
- total: 29209 ms
- gen tok/s: 16.6
- completion tokens: 12
- needle recalled: ✓

**preamble (sent first):**

```
IMPORTANT BACKGROUND FACT: The codeword for today is "BANANA-CARNIVAL-9417". Remember this exact codeword. What follows is unrelated filler context.
```

**question (sent last):**

```
End of filler. Question: what was the exact codeword given at the very beginning of this message? Reply with just the codeword and nothing else.
```

**model reply:**

```
BANANA-CARNIVAL-9417
```

---

## requested 7500 tokens (actual prompt_tokens=0)

- ttft: — ms
- total: 1126 ms
- gen tok/s: 0.0
- completion tokens: 0
- needle recalled: ✗
- **error:** The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input

**preamble (sent first):**

```
IMPORTANT BACKGROUND FACT: The codeword for today is "BANANA-CARNIVAL-9417". Remember this exact codeword. What follows is unrelated filler context.
```

**question (sent last):**

```
End of filler. Question: what was the exact codeword given at the very beginning of this message? Reply with just the codeword and nothing else.
```

**model reply:**

```
(empty)
```
