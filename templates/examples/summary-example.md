---
source: [[raw/brillm-brain-inspired-llm.md]]
compiled: 2026-04-05
---
# BriLLM: Brain-inspired Large Language Model (arXiv paper)

BriLLM proposes a graph-based language model using SiFu (Signal Fully-connected Flowing) learning that replaces Transformer attention with directed signal propagation through a vocabulary-sized graph, achieving full node-level interpretability and context-length-independent model size.

## Key Points

- **Authors**: Hai Zhao et al., Shanghai Jiao Tong University (arXiv 2503.11299, v7: 2025-08-12)
- **Core problem addressed**: Three Transformer limitations -- black-box opacity, quadratic O(L^2) complexity, context-length dependency
- **SiFu mechanism**: Two brain-inspired principles -- static semantic grounding (each node = one vocab token, analogous to cortical regions) + dynamic signal propagation (energy flows along edges, mimicking electrophysiology)
- **Signal formula**: `e_{i+1} = GeLU(W_{u_i, u_{i+1}} * e_i + bias + PE_i)`, next token = argmax L2 norm
- **Model sizes**: Theoretical 16.9B (fully connected); sparse Chinese 2.19B (13% density); sparse English 0.96B (5.7% density)
- **Training data**: Chinese/English Wikipedia, vocab 4000-4096 tokens, sequence length 32
- **Results**: Stable loss convergence; Chinese generation quality good; English quality notably degraded
- **Scaling claim**: 40k-token vocab with sparse training -> 100-200B params, context-length independent
- **Limitations**: 32-token training sequences, no SFT validation, English quality poor, GPT-1-level only, compute not yet demonstrated at scale
- **Critical assessment**: O(1) model size claim holds, but inference cost still scales with sequence length; interpretability claim needs rigorous evaluation

## Related Concepts

- [[concepts/sifu-learning]] -- the core signal propagation mechanism described in detail
- [[concepts/brain-inspired-architecture]] -- the neurocognitive framing (cortical semantic maps, electrophysiology)
- [[concepts/sparse-graph-training]] -- how fully-connected graph is reduced to 5-13% density
- [[concepts/context-length-independence]] -- the O(1) model size claim relative to context
- [[concepts/interpretability]] -- full node-level transparency claim
