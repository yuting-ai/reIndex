import os
from neo4j import GraphDatabase
from dotenv import load_dotenv
from pathlib import Path

env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)


class GraphDBClient:
    def __init__(self, uri=None, user=None, password=None):
        self.uri = uri or os.getenv("NEO4J_URI", "bolt://localhost:7687")
        self.user = user or os.getenv("NEO4J_USER", "neo4j")
        self.password = password or os.getenv("NEO4J_PASSWORD", "reindex123")
        self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.password))

    def close(self):
        self.driver.close()

    def add_triplets(self, file_id: str, triplets: list):
        if not triplets:
            return
        with self.driver.session() as session:
            for t in triplets:
                subject = t.get("subject", "").strip()
                predicate = t.get("predicate", "").strip()
                obj = t.get("object", "").strip()
                if not subject or not predicate or not obj:
                    continue
                predicate_clean = predicate.replace("`", "")
                query = f"""
                MERGE (s:Entity {{name: $subject}})
                MERGE (o:Entity {{name: $object}})
                MERGE (s)-[r:`{predicate_clean}`]->(o)
                SET r.source_file = $file_id
                """
                session.run(query, subject=subject, object=obj, file_id=file_id)

    def delete_file_triplets(self, file_id: str) -> int:
        deleted = 0
        with self.driver.session() as session:
            # Single pass: find affected nodes, delete their relationships,
            # then delete nodes that become orphaned.
            result = session.run("""
                MATCH (n)
                OPTIONAL MATCH (n)-[r]-()
                WHERE r.source_file = $file_id
                WITH n, r
                DELETE r
                WITH n
                WHERE NOT (n)--()
                DELETE n
                RETURN count(*) AS deleted
            """, file_id=file_id)
            record = result.single()
            if record:
                deleted = record["deleted"]
        return deleted

    def query_subgraph(self, entity_names: list, max_hops: int = 2) -> list:
        if not entity_names:
            return []
        with self.driver.session() as session:
            query = f"""
            MATCH p=(n:Entity)-[*1..{max_hops}]-(m:Entity)
            WHERE n.name IN $entity_names
            RETURN relationships(p) AS rels
            """
            result = session.run(query, entity_names=entity_names)
            extracted_rels = set()
            for record in result:
                for rel in record["rels"]:
                    subj = rel.nodes[0]["name"]
                    obj = rel.nodes[1]["name"]
                    pred = rel.type
                    extracted_rels.add(f"({subj}) -[{pred}]-> ({obj})")
            return list(extracted_rels)

    def get_schema(self):
        with self.driver.session() as session:
            labels_result = session.run("""
                MATCH (n)
                RETURN DISTINCT labels(n) as labels
            """)
            labels_set = set()
            for record in labels_result:
                for label in record["labels"]:
                    labels_set.add(label)

            try:
                rels_result = session.run("""
                    MATCH ()-[r]->()
                    RETURN DISTINCT type(r) AS relationshipType
                """)
                relationships = [r["relationshipType"] for r in rels_result]
            except Exception:
                relationships = []

            return {
                "labels": sorted(labels_set),
                "relationships": sorted(relationships),
            }

    def explore_graph(self, limit: int = 500):
        with self.driver.session() as session:
            result = session.run("""
                MATCH (n)
                OPTIONAL MATCH (n)-[r]-(m)
                RETURN n, r, m
                LIMIT $limit
            """, limit=limit)

            node_map = {}
            edges = []
            seen_edges = set()

            for record in result:
                n = record["n"]
                if n and n.element_id not in node_map:
                    props = dict(n)
                    node_map[n.element_id] = {
                        "id": n.element_id,
                        "label": props.get("name", props.get("title", n.element_id)),
                        "labels": list(n.labels),
                        "properties": props,
                    }

                r = record["r"]
                if r and r.element_id not in seen_edges:
                    seen_edges.add(r.element_id)
                    edges.append({
                        "id": r.element_id,
                        "from": r.start_node.element_id,
                        "to": r.end_node.element_id,
                        "label": r.type,
                    })

            return {"nodes": list(node_map.values()), "edges": edges}


graph_db = GraphDBClient()
