# This repository has been migrated to the self-hosted ari-web Forgejo instance: <https://git.ari.lt/ari/quotes-bot>
# Quotes bot

A quotes bot integrating with [Imag](https://ari.lt/gh/imag) !

See `config.example.mjs` to configure it.

# Running

```sh
cp config.example.mjs config.mjs
vim config.mjs  # Configure it
docker compose build --no-cache
docker compose up -d
```
