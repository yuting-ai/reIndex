import os
import uuid
from typing import List, Dict, Any
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from sentence_transformers import SentenceTransformer

# 1. Initialize Native Local Embedding Model
# We load it directly into the Python process to eliminate dependency on external Ollama servers
EMBEDDING_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
VECTOR_SIZE = 384  # all-MiniLM-L6-v2 produces 384-dimensional vectors

print(f"Loading local embedding model: {EMBEDDING_MODEL_NAME}...")
embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
print("Embedding model loaded successfully.")

def get_ollama_embedding(text: str) -> List[float]:
    """Get embedding vector natively using sentence-transformers.
       Kept the function name as get_ollama_embedding for backward compatibility
       so we don't have to change other files that might be calling it.
    """
    return embedding_model.encode(text).tolist()

# 2. Initialize Qdrant Client (Local storage mode)
QDRANT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "qdrant_data")
client = QdrantClient(path=QDRANT_PATH)

COLLECTION_NAME = "memory_summaries"

# Ensure collection exists
if not client.collection_exists(collection_name=COLLECTION_NAME):
    client.create_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
    )
    print(f"Created new Qdrant collection: {COLLECTION_NAME}")

def upsert_file_summary(file_id: str, file_name: str, summary: str, key_entities: list = None):
    """
    Generates an embedding for the file's LLM summary and stores it as
    a single vector in Qdrant. This is the "memory layer" — search hits
    summaries first, not raw file content.
    """
    if not summary or not summary.strip():
        return

    # Combine summary with entities for a richer embedding
    embedding_text = summary
    if key_entities:
        embedding_text += " " + " ".join(key_entities)

    vector = get_ollama_embedding(embedding_text)

    # Use a deterministic point ID derived from the file UUID
    point_id = str(uuid.uuid5(uuid.UUID(file_id), "summary"))

    client.upsert(
        collection_name=COLLECTION_NAME,
        points=[
            PointStruct(
                id=point_id,
                vector=vector,
                payload={
                    "file_id": file_id,
                    "file_name": file_name,
                    "summary": summary,
                    "key_entities": key_entities or []
                }
            )
        ]
    )
    print(f"  -> Upserted summary vector for {file_name}")

def search(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """
    Searches the memory layer (summaries) in Qdrant.
    Returns the most relevant file summaries ranked by cosine similarity.
    """
    query_vector = get_ollama_embedding(query)

    search_result = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        limit=limit
    )

    results = []
    for hit in search_result.points:
        results.append({
            "score": round(hit.score * 100, 2),
            "file_id": hit.payload.get("file_id"),
            "file_name": hit.payload.get("file_name"),
            "summary": hit.payload.get("summary"),
            "key_entities": hit.payload.get("key_entities", [])
        })

    return results

def delete_file_vectors(file_id: str):
    """Deletes the summary vector belonging to a file."""
    from qdrant_client.http import models
    client.delete(
        collection_name=COLLECTION_NAME,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="file_id",
                        match=models.MatchValue(value=file_id),
                    ),
                ],
            )
        ),
    )
    print(f"  -> Deleted summary vector for file {file_id}")
