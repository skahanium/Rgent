import os
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIChatModel(
    'MiniMax-M3',
    provider=OpenAIProvider(
        # 国际站用 https://api.minimax.io/v1
        base_url='https://api.minimaxi.com/v1',
        api_key=os.getenv('MINIMAX_API_KEY'),
    ),
)

agent = Agent(
    model,
    instructions='Be concise, reply with one sentence.',
)

result = agent.run_sync('Where does "hello world" come from?')
print(result.output)
