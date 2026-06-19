import os
import json
from pathlib import Path
from openai import OpenAI
from dotenv import load_dotenv

# Load the root-level .env file regardless of where the script is run from
load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

# Configuration Switch: "local" for Ollama, "api" for third-party (e.g., OpenAI, DeepSeek)
LLM_MODE = os.environ.get("LLM_MODE", "api")
# LLM_MODE = "api"

# Provider settings
CONFIG = {
    "local": {
        "base_url": "http://localhost:11434/v1", # Ollama's OpenAI-compatible endpoint
        "api_key": "ollama", # Ollama doesn't need a real key, but client requires a non-empty string
        "model": "gemma4:12b" # Recommended local model for Chinese comprehension and instruction following
    },
    "api": {
        "base_url": os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        "api_key": os.environ["DEEPSEEK_API_KEY"],
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")
    }
}

def get_llm_client() -> OpenAI:
    """Initializes and returns the OpenAI client configured for the selected mode."""
    settings = CONFIG[LLM_MODE]
    print(f"🔌 Using LLM Mode: [{LLM_MODE}] | Model: {settings['model']} | Endpoint: {settings['base_url']}")
    
    return OpenAI(
        base_url=settings["base_url"],
        api_key=settings["api_key"]
    )

def generate_summary_and_entities(text_content: str) -> dict:
    """
    Sends the text content to the LLM and asks for a summary and key entities.
    Returns a dictionary with keys 'summary' and 'key_entities'.
    """
    client = get_llm_client()
    settings = CONFIG[LLM_MODE]
    
    # We enforce JSON output formatting in the prompt to make parsing robust.
    system_prompt = """
    You are an intelligent file analysis assistant. 
    Read the provided file content and extract a concise summary and a list of key entities (like people, companies, project names, technical terms, etc.).
    
    CRITICAL INSTRUCTIONS:
    1. DO NOT output any thinking process, reasoning, or <think> tags.
    2. DO NOT output markdown code blocks.
    3. You MUST respond ONLY with a valid JSON object exactly matching this structure:
    {
        "summary": "A 50-100 word summary of the file content.",
        "key_entities": ["Entity1", "Entity2", "Entity3"]
    }
    """

    # Limit text to roughly 8000 characters to avoid exceeding the context window of smaller local models
    safe_text_content = text_content[:8000]
    user_prompt = f"Here is the file content:\n\n{safe_text_content}"

    try:
        response = client.chat.completions.create(
            model=settings["model"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            # Note: response_format JSON is supported by Ollama and OpenAI. 
            # It ensures the model outputs parsable JSON rather than conversational text.
            response_format={"type": "json_object"}, 
            temperature=0.3
        )
        
        # Parse the JSON response
        result_text = response.choices[0].message.content
        return json.loads(result_text)
        
    except Exception as e:
        print(f"❌ Error calling LLM: {e}")
        return {
            "summary": "Error generating summary.",
            "key_entities": []
        }

def rewrite_search_query(user_query: str) -> str:
    """
    Rewrites a conversational user query into a focused, keyword-rich search string
    for vector database retrieval.
    """
    client = get_llm_client()
    settings = CONFIG[LLM_MODE]
    
    system_prompt = """
    You are an AI search assistant. The user will provide a natural language query about their local files.
    Your job is to extract the core search intent and convert it into a highly focused, keyword-rich search string.
    - Remove conversational filler words (e.g., "hello", "please find", "I remember there was", etc.).
    - Keep only the most important nouns, entities, dates, or concepts.
    - DO NOT output any reasoning, tags, or JSON.
    - Output ONLY the rewritten search string without quotes.
    """

    try:
        response = client.chat.completions.create(
            model=settings["model"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_query}
            ],
            temperature=0.1
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"❌ Error rewriting query: {e}")
        return user_query  # Fallback to the original query



def extract_triplets(text_content: str) -> list:
    """
    Extracts knowledge graph triplets from the text content.
    Returns a list of dictionaries: [{"subject": "A", "predicate": "REL", "object": "B"}]
    """
    client = get_llm_client()
    settings = CONFIG[LLM_MODE]
    
    system_prompt = """
    You are an expert Knowledge Graph extraction system.
    Extract the most important relationships from the provided text as Triplets (Subject, Predicate, Object).
    All predicates MUST be in ENGLISH.

    CRITICAL RULES FOR ENTITY RESOLUTION:
    - ALWAYS use the most complete, formal name for entities. 
      (e.g., If text says "Green Tree Company" or "Green Tree", you MUST output the full "Green Tree Special Materials Co., Ltd.". If "Project Moon", output "Project Moon".)
    - DO NOT use pronouns (he, she, it). Resolve them to the actual person or entity name.
    - Ensure names of people and companies are consistent.

    CRITICAL RULES FOR RELATIONSHIPS:
    - Extract EVERY meaningful connection. Do not be lazy. You should extract between 5 to 20 triplets.
    - Predicate MUST be a highly specific, standardized English verb phrase in UPPER_SNAKE_CASE.
    - NEVER use generic words like "associated" or "related".
    - NEVER use Chinese for predicate.
    - Preferred verb whitelist (use these or similar highly specific verbs):
      [WORKS_AT, RELATES_TO, RESPONSIBLE_FOR, MENTIONS, INVESTED_IN,
       MANAGES, PARTICIPATES_IN, SERVES_AS, APPROVED, FUNDED,
       BELONGS_TO, CONTAINS, PRODUCES, PROVIDES, LOCATED_IN,
       STUDIES_AT, COLLABORATES_WITH, DEVELOPS, OWNS, LEADS]

    - DO NOT output Markdown blocks.
    - You MUST output ONLY a valid JSON object with a single key "triplets" containing the array of objects.

    Example:
    {
      "triplets": [
        {"subject": "Zhang San", "predicate": "APPROVED", "object": "Expense Report EXP-001"},
        {"subject": "Wang Wu", "predicate": "SERVES_AS", "object": "Green Tree Special Materials Co., Ltd."},
        {"subject": "Mars Capital", "predicate": "INVESTED_IN", "object": "Green Tree Special Materials Co., Ltd."},
        {"subject": "Li Si", "predicate": "WORKS_AT", "object": "Mars Capital"}
      ]
    }
    """

    safe_text_content = text_content[:8000]
    user_prompt = f"Text to extract:\n\n{safe_text_content}"

    try:
        response = client.chat.completions.create(
            model=settings["model"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.1
        )
        result_text = response.choices[0].message.content.strip()
        data = json.loads(result_text)
        return data.get("triplets", [])
    except Exception as e:
        print(f"❌ Error extracting triplets: {e}")
        return []


