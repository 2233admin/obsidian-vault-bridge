---
compiled: 2026-04-05
---
# SiFu Learning (Signal Fully-connected Flowing)

The core mechanism of BriLLM: a directed graph where vocabulary tokens are nodes and edges carry learnable weight matrices, with signal energy propagated through the graph to predict the next token via argmax over L2 norm.

## Overview

SiFu (Signal Fully-connected Flowing) replaces the attention mechanism with a graph-based signal propagation process. The model maintains a directed graph where each node corresponds to exactly one vocabulary token. Between any two tokens, a directed edge carries a weight matrix W in R^(d x d) and a bias vector, where d=32 (hidden_size).

The signal starts as a uniform vector e_0 = [1/d, ..., 1/d] and propagates through the token sequence:

```
e_{i+1} = GeLU(W_{u_i, u_{i+1}} * e_i + b_{u_i, u_{i+1}} + PE_i)
```

At each generation step, the model evaluates all candidate next tokens by computing the energy (L2 norm of the resulting signal) and selects the argmax. For training, the correct next token must have higher L2 norm than k=400 negative samples, optimized via CrossEntropy loss.

Positional information is injected via sinusoidal positional encoding (computed on-the-fly) combined with learnable softmax-weighted positional aggregation (`positions` parameter, shape 1x512x1).

## Key Properties

- **No attention matrix**: context is encoded in the accumulated energy state, not pairwise attention weights
- **Autoregressive**: generates one token at a time, left-to-right
- **Temperature**: at inference, `probs = softmax(energy) / temperature` for controlled sampling
- **Initial signal**: paper uses all-ones vector; implementation uses uniform 1/d

## Sources

- [[summaries/brillm-brain-inspired-llm]] -- theoretical formulation, mathematical derivation, comparison to attention
- [[summaries/brillm-github-implementation]] -- implementation details: parameter layout, forward pass, decode loop
