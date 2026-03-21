import json
import math
import os
import sys


def dot(a, b):
    return sum(float(x) * float(y) for x, y in zip(a, b))


def norm(v):
    return math.sqrt(sum(float(x) * float(x) for x in v))


def cosine_similarity(a, b):
    denom = norm(a) * norm(b)
    if denom == 0:
      return 0.0
    return dot(a, b) / denom


def main():
    payload = json.loads(sys.stdin.read())
    query = payload["query"]
    documents = payload["documents"]
    model_name = payload.get("model_name") or os.getenv("BGE_MODEL") or "BAAI/bge-small-en-v1.5"

    try:
        from fastembed import TextEmbedding
    except ImportError:
        print(json.dumps({"error": "fastembed is not installed"}))
        sys.exit(1)

    embedder = TextEmbedding(model_name=model_name)
    inputs = [query] + documents
    vectors = list(embedder.embed(inputs))

    query_vec = vectors[0]
    ranked = []
    for index, doc_vec in enumerate(vectors[1:]):
        ranked.append({
            "index": index,
            "score": cosine_similarity(query_vec, doc_vec)
        })

    ranked.sort(key=lambda item: item["score"], reverse=True)
    print(json.dumps({
        "model": model_name,
        "ranked": ranked
    }))


if __name__ == "__main__":
    main()
