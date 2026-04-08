#!/usr/bin/env bash
# NEXUS CLI shell completion — bash and zsh
#
# Installation:
#   bash:  echo 'source "$(nexus --completion-script-path 2>/dev/null || echo ~/.nexus/completion.sh)"' >> ~/.bashrc
#   zsh:   echo 'source "$(nexus --completion-script-path 2>/dev/null || echo ~/.nexus/completion.sh)"' >> ~/.zshrc
#
# Or manually:
#   cp scripts/completion.sh ~/.nexus/completion.sh
#   echo 'source ~/.nexus/completion.sh' >> ~/.zshrc

# ── Top-level nexus commands ───────────────────────────────────────────────────

_nexus_commands=(
  "start:Start the NEXUS daemon"
  "stop:Stop the NEXUS daemon"
  "restart:Restart the NEXUS daemon"
  "status:Show daemon status"
  "setup:Run interactive setup"
  "verify:Verify your configuration"
  "doctor:Run health checks"
  "logs:Show or tail logs"
  "config:Show or edit configuration"
  "update:Update NEXUS to latest version"
  "agents:List available agents"
  "memory:Manage the memory database"
  "screenshot:Take a screenshot"
  "health:Check system health"
  "version:Show version info"
  "uninstall:Remove NEXUS"
  "chat:Chat with NEXUS in terminal"
  "workspace:Manage the workspace"
  "dream:Run the dream/consolidation cycle"
  "mcp:Start in MCP server mode"
  "providers:List AI provider presets"
  "plugins:List installed plugins"
  "sessions:Manage conversation sessions"
)

_nexus_sessions_commands=(
  "list:List all sessions"
  "cleanup:Remove old sessions"
  "export:Export a session as text"
)

_nexus_memory_commands=(
  "stats:Show memory statistics"
  "search:Search memories"
  "clear:Clear old memories"
  "export:Export memories to JSON"
)

_nexus_config_keys=(
  "ai.provider"
  "ai.model"
  "telegram.botToken"
  "telegram.allowedUsers"
  "personality.name"
)

# ── Bash completion ────────────────────────────────────────────────────────────

_nexus_bash_completion() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
  }

  case "$prev" in
    nexus)
      local cmds
      cmds=$(printf '%s\n' "${_nexus_commands[@]}" | cut -d: -f1)
      COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
      return 0
      ;;
    sessions)
      local cmds
      cmds=$(printf '%s\n' "${_nexus_sessions_commands[@]}" | cut -d: -f1)
      COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
      return 0
      ;;
    memory)
      local cmds
      cmds=$(printf '%s\n' "${_nexus_memory_commands[@]}" | cut -d: -f1)
      COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
      return 0
      ;;
    logs)
      COMPREPLY=($(compgen -W "--follow --lines --tail --error" -- "$cur"))
      return 0
      ;;
    mcp)
      COMPREPLY=($(compgen -W "--http --port" -- "$cur"))
      return 0
      ;;
    config)
      local keys
      keys=$(printf '%s\n' "${_nexus_config_keys[@]}")
      COMPREPLY=($(compgen -W "$keys" -- "$cur"))
      return 0
      ;;
    export)
      # Session export — complete from ~/.nexus/sessions/
      local sess_dir="$HOME/.nexus/sessions"
      if [[ -d "$sess_dir" ]]; then
        local sessions
        sessions=$(ls "$sess_dir" 2>/dev/null | sed 's/\.json$//')
        COMPREPLY=($(compgen -W "$sessions" -- "$cur"))
      fi
      return 0
      ;;
  esac

  # Default: complete with nexus commands
  local cmds
  cmds=$(printf '%s\n' "${_nexus_commands[@]}" | cut -d: -f1)
  COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
}

# ── Zsh completion ─────────────────────────────────────────────────────────────

_nexus_zsh_completion() {
  local -a commands sessions_cmds memory_cmds

  commands=(
    ${_nexus_commands[@]}
  )

  sessions_cmds=(
    ${_nexus_sessions_commands[@]}
  )

  memory_cmds=(
    ${_nexus_memory_commands[@]}
  )

  local state
  _arguments -C \
    '1: :->cmd' \
    '2: :->subcmd' \
    '*: :->args' && return 0

  case $state in
    cmd)
      _describe 'nexus command' commands
      ;;
    subcmd)
      case "${words[2]}" in
        sessions)
          _describe 'sessions command' sessions_cmds
          ;;
        memory)
          _describe 'memory command' memory_cmds
          ;;
        mcp)
          _arguments '--http[Use HTTP transport]' '--port[Port number]:port'
          ;;
        logs)
          _arguments '--follow[Follow log output]' '--lines[Number of lines]:n' '--error[Show only errors]'
          ;;
        sessions)
          case "${words[3]}" in
            export)
              local sess_dir="$HOME/.nexus/sessions"
              if [[ -d "$sess_dir" ]]; then
                local -a sessions
                sessions=($(ls "$sess_dir" 2>/dev/null | sed 's/\.json$//'))
                _describe 'session' sessions
              fi
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

# ── Register completion ────────────────────────────────────────────────────────

if [[ -n "${ZSH_VERSION:-}" ]]; then
  # Zsh
  if type compdef &>/dev/null; then
    compdef _nexus_zsh_completion nexus
  else
    autoload -U compinit
    compinit
    compdef _nexus_zsh_completion nexus
  fi
elif [[ -n "${BASH_VERSION:-}" ]]; then
  # Bash
  if type complete &>/dev/null; then
    complete -F _nexus_bash_completion nexus
  fi
fi
