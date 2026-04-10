#!/usr/bin/env python3
"""
Patch OllamaEmbeddingEngine to use TikTokenTokenizer instead of HuggingFaceTokenizer.
This avoids any HuggingFace network calls at startup.
"""
import re

TARGET = "/app/cognee/infrastructure/databases/vector/embeddings/OllamaEmbeddingEngine.py"

with open(TARGET) as f:
    content = f.read()

if "TikTokenTokenizer" in content:
    print("Already patched, skipping.")
else:
    content = content.replace(
        "from cognee.infrastructure.llm.tokenizer.HuggingFace import (\n    HuggingFaceTokenizer,\n)",
        "from cognee.infrastructure.llm.tokenizer.TikToken import TikTokenTokenizer"
    )
    content = re.sub(
        r"def get_tokenizer\(self\):.*?return tokenizer",
        "def get_tokenizer(self):\n        tokenizer = TikTokenTokenizer(max_completion_tokens=self.max_completion_tokens)\n        return tokenizer",
        content,
        flags=re.DOTALL
    )
    with open(TARGET, "w") as f:
        f.write(content)
    print("Patched OllamaEmbeddingEngine to use TikTokenTokenizer.")
