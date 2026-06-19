import os
from pathlib import Path
from dotenv import load_dotenv
from agents import Agent, Runner, function_tool
from openai import AsyncOpenAI
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel

# Import local tools
from agent.tools import (
    search_knowledge_base, 
    read_local_file, 
    rename_local_file
)

# 1. Dynamically load config from backend/.env
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

# Map DEEPSEEK environment variables for OpenAI SDK usage
os.environ["OPENAI_BASE_URL"] = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
os.environ["OPENAI_API_KEY"] = os.getenv("DEEPSEEK_API_KEY", "")

# Read model name from env vars, default to deepseek-chat if not set
model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

deepseek_client = AsyncOpenAI(
    api_key=os.getenv("DEEPSEEK_API_KEY", ""),
    base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
)

deepseek_model = OpenAIChatCompletionsModel(
    model=model_name,
    openai_client=deepseek_client
)

# 2. Create a base Agent with tools
agent = Agent(
    name="Reindex Master Agent",
    instructions="You are a top-tier GraphRAG knowledge graph detective and file system manager. When answering questions, prioritize graph relationships and summaries over raw file reading. Note: Directory organization and file categorizations are handled automatically by the native UI button, so you do not need to perform those actions yourself. Just guide the user to click the '✨ 整理' (Organize) button in the interface.",
    model=deepseek_model,
    tools=[
        function_tool(search_knowledge_base), 
        function_tool(read_local_file),
        function_tool(rename_local_file)
    ],
)

