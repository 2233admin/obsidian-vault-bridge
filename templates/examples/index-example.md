# brillm Knowledge Base

> Auto-maintained index. Do not edit manually.
> Sources: 2 | Articles: 2 | Concepts: 6 | Last compiled: 2026-04-06

## Summaries
| File | One-liner |
|------|-----------|
| [[summaries/brillm-brain-inspired-llm]] | BriLLM proposes a graph-based language model using SiFu (Signal Fully-connected Flowing) learning that replaces Transformer attention with directed si |
| [[summaries/brillm-github-implementation]] | The official BriLLM0.5 implementation (316 stars, 42 forks) provides PyTorch code for the BraLM model class with sparse directed-graph parameter layou |

## Concepts
| File | One-liner |
|------|-----------|
| [[concepts/brain-inspired-architecture]] | BriLLM's design is grounded in two neurocognitive principles: static semantic grounding (each graph node maps to a specific vocabulary token, analogou |
| [[concepts/bralm-implementation]] | The BraLM class in model.py is the concrete PyTorch implementation of BriLLM, storing all edge parameters as flat tensors indexed by a `weight_indices |
| [[concepts/context-length-independence]] | BriLLM's model size is determined solely by vocabulary size (O(V^2) edges), not sequence length, giving O(1) model complexity relative to context -- u |
| [[concepts/interpretability]] | BriLLM claims full node-level interpretability: every model component maps to a specific vocabulary token, and signal propagation paths through the gr |
| [[concepts/sifu-learning]] | The core mechanism of BriLLM: a directed graph where vocabulary tokens are nodes and edges carry learnable weight matrices, with signal energy propaga |
| [[concepts/sparse-graph-training]] | BriLLM reduces its theoretically fully-connected vocabulary graph (16.9B parameters for 4000-token vocab) to 5-13% density by sharing a single fixed p |

## Queries
| File | One-liner |
|------|-----------|

