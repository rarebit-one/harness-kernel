ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# git + gh so the usual worktree/PR workflow works inside the container;
# ca-certificates/curl for npm over TLS.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    git \
    ca-certificates \
    curl \
    gpg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get -y install --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The base image's `node` user is uid 1000; rename it to `vscode` for
# devcontainer compatibility.
RUN usermod -l vscode -d /home/vscode -m node \
    && groupmod -n vscode node

USER vscode
