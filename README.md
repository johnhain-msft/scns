# CI model cache

Single asset: `fast-bge-small-en-v1.5.tar.gz` — the BGE-small-en-v1.5 fastembed model in extracted-layout form (tar of the `fast-bge-small-en-v1.5/` directory).

**Why this branch exists:** fastembed-js downloads this model from the public GCS bucket `qdrant-fastembed` on first use. That bucket began answering anonymous requests with 403 AccessDenied between 2026-09-23 (last green CI download) and 2026-10-05; fastembed then tar-extracts the saved XML error body, so every embedding-dependent integration test failed on CI with `TAR_BAD_ARCHIVE`. The Qdrant Hugging Face mirror is login-gated as well. CI therefore seeds `local_cache/` from this branch (see the 'Seed embedding model cache' step in ci.yml); fastembed sees the extracted directory and never downloads.

Contents are byte-identical to the model directory a healthy download produced, verified working on the live Mac deployment. Orphan branch: it shares no history with main and is only fetched by the CI step (depth 1), so normal clones never pay for it.

To refresh: `tar czf fast-bge-small-en-v1.5.tar.gz -C local_cache fast-bge-small-en-v1.5`, then recreate this branch with the new blob.
