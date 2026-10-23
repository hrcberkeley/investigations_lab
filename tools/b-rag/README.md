# In‑Browser RAG (No Backend)

Static web app: upload docs → chunk → embed → retrieve → answer with Prompt API (`window.LanguageModel`).

## Components

- Embeddings: Transformers.js `pipeline('feature-extraction', ...)` and `device: 'webgpu'` when available.
- PDF parsing: pdfjs-dist `getTextContent()` (text PDFs; scanned PDFs need OCR).
- DOCX parsing: mammoth (DOCX → HTML → text)
- Storage: IndexedDB (chunks + embeddings)
- Retrieval: cosine similarity (top‑K)

## Run locally

```bash
cd lmp-rag-webapp
python3 -m http.server 8000
# open http://localhost:8000
```
