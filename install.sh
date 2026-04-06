#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
#  NEXUS AI — Premium CLI Installer
#  Personal AI That Lives On Your Mac
# ──────────────────────────────────────────────────────────────────────

VERSION="0.1.0"

# ─── Colors (ANSI 256) ──────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# 256-color gradient palette (cyan → indigo → purple)
C1='\033[38;5;51m'   # bright cyan
C2='\033[38;5;45m'   # cyan
C3='\033[38;5;39m'   # light blue
C4='\033[38;5;63m'   # blue-purple
C5='\033[38;5;99m'   # indigo
C6='\033[38;5;135m'  # purple
C7='\033[38;5;171m'  # magenta
C8='\033[38;5;177m'  # light magenta

# Spinner characters
SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

# ─── Utilities ───────────────────────────────────────────────────────

spinner() {
  local pid=$1
  local msg=$2
  local i=0
  tput civis 2>/dev/null || true  # hide cursor
  while kill -0 "$pid" 2>/dev/null; do
    local char="${SPINNER:$i:1}"
    printf "\r  ${CYAN}${char}${NC} ${msg}"
    i=$(( (i + 1) % ${#SPINNER} ))
    sleep 0.08
  done
  wait "$pid" 2>/dev/null
  local exit_code=$?
  tput cnorm 2>/dev/null || true  # show cursor
  if [ $exit_code -eq 0 ]; then
    printf "\r  ${GREEN}✓${NC} ${msg}                    \n"
  else
    printf "\r  ${RED}✗${NC} ${msg}                    \n"
    return $exit_code
  fi
}

animated_check() {
  local msg=$1
  local delay=${2:-0.6}
  local i=0
  tput civis 2>/dev/null || true
  local end_time=$(perl -e "print time + $delay")
  while [ "$(perl -e 'print time')" -lt "$end_time" ]; do
    local char="${SPINNER:$i:1}"
    printf "\r  ${CYAN}${char}${NC} ${msg}"
    i=$(( (i + 1) % ${#SPINNER} ))
    sleep 0.08
  done
  tput cnorm 2>/dev/null || true
  printf "\r  ${GREEN}✓${NC} ${msg}                    \n"
}

progress_bar() {
  local pid=$1
  local msg=$2
  local width=40
  local i=0
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    i=$(( (i + 1) % (width + 1) ))
    local filled=""
    local empty=""
    for ((j=0; j<width; j++)); do
      if [ $j -lt $i ]; then
        filled="${filled}█"
      else
        empty="${empty}░"
      fi
    done
    printf "\r  ${CYAN}${filled}${DIM}${empty}${NC} ${msg}"
    sleep 0.15
  done
  wait "$pid" 2>/dev/null
  local exit_code=$?
  tput cnorm 2>/dev/null || true
  # Fill the bar completely
  local full=""
  for ((j=0; j<width; j++)); do
    full="${full}█"
  done
  if [ $exit_code -eq 0 ]; then
    printf "\r  ${GREEN}${full}${NC} ${msg}  ${GREEN}✓${NC}\n"
  else
    printf "\r  ${RED}${full}${NC} ${msg}  ${RED}✗${NC}\n"
    return $exit_code
  fi
}

success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $1"; }
error()   { echo -e "  ${RED}✗${NC} $1"; }
info()    { echo -e "  ${CYAN}ℹ${NC} $1"; }

section() {
  echo ""
  echo -e "  ${BLUE}${BOLD}━━━ $1 ━━━${NC}"
  echo ""
}

die() {
  echo ""
  error "$1"
  echo -e "  ${DIM}$2${NC}"
  echo ""
  exit 1
}

# ─── ASCII Art Logo with Gradient ────────────────────────────────────

show_logo() {
  clear
  echo ""
  echo ""
  echo -e "${BOLD}${C1}    ███╗   ██╗${C2}███████╗${C3}██╗  ██╗${C4}██╗   ██╗${C5}███████╗${NC}"
  echo -e "${BOLD}${C1}    ████╗  ██║${C2}██╔════╝${C3}╚██╗██╔╝${C4}██║   ██║${C5}██╔════╝${NC}"
  echo -e "${BOLD}${C2}    ██╔██╗ ██║${C3}█████╗  ${C4} ╚███╔╝ ${C5}██║   ██║${C6}███████╗${NC}"
  echo -e "${BOLD}${C3}    ██║╚██╗██║${C4}██╔══╝  ${C5} ██╔██╗ ${C6}██║   ██║${C7}╚════██║${NC}"
  echo -e "${BOLD}${C4}    ██║ ╚████║${C5}███████╗${C6}██╔╝ ╚██╗${C7}╚██████╔╝${C8}███████║${NC}"
  echo -e "${BOLD}${C5}    ╚═╝  ╚═══╝${C6}╚══════╝${C7}╚═╝   ╚═╝${C7} ╚═════╝ ${C8}╚══════╝${NC}"
  echo ""
  echo -e "    ${C4}v${VERSION}${NC}  ${DIM}·${NC}  ${C6}Personal AI That Lives On Your Mac${NC}"
  echo -e "    ${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# ─── Trap for clean exit ─────────────────────────────────────────────

cleanup() {
  tput cnorm 2>/dev/null || true
  echo ""
}
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════════
#  MAIN INSTALLATION FLOW
# ══════════════════════════════════════════════════════════════════════

show_logo

echo -e "  ${BOLD}Welcome to the NEXUS installer.${NC}"
echo -e "  ${DIM}This will check your system, install dependencies, and${NC}"
echo -e "  ${DIM}launch the interactive setup wizard.${NC}"
echo ""
echo -e "  ${DIM}Press Ctrl+C at any time to cancel.${NC}"
echo ""

# ─── 1. System Requirements ─────────────────────────────────────────

section "System Requirements"

# macOS check
if [[ "$(uname)" != "Darwin" ]]; then
  die "NEXUS requires macOS." "Detected: $(uname). NEXUS uses macOS-specific APIs (screen capture, accessibility)."
fi
animated_check "macOS detected — $(sw_vers -productVersion) ($(uname -m))" 0.5

# Node.js check
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 22 ]; then
    animated_check "Node.js v${NODE_VERSION}" 0.4
  else
    warn "Node.js v${NODE_VERSION} found — v22+ required"
    echo ""
    if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
      info "nvm detected. Installing Node.js 22..."
      # Source nvm if not already available
      [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
      (nvm install 22 && nvm use 22) &>/dev/null &
      spinner $! "Installing Node.js 22 via nvm..."
    elif command -v brew &>/dev/null; then
      info "Installing Node.js 22 via Homebrew..."
      brew install node@22 &>/dev/null &
      spinner $! "Installing Node.js 22 via Homebrew..."
      # Link if needed
      brew link --force --overwrite node@22 &>/dev/null 2>&1 || true
    else
      die "Node.js 22+ is required but v${NODE_VERSION} is installed." \
          "Install nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash\nThen: nvm install 22"
    fi
  fi
else
  warn "Node.js not found"
  echo ""
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    info "Installing Node.js 22 via nvm..."
    (nvm install 22 && nvm use 22) &>/dev/null &
    spinner $! "Installing Node.js 22 via nvm..."
  elif command -v brew &>/dev/null; then
    info "Installing Node.js 22 via Homebrew..."
    brew install node@22 &>/dev/null &
    spinner $! "Installing Node.js 22 via Homebrew..."
    brew link --force --overwrite node@22 &>/dev/null 2>&1 || true
  else
    die "Node.js 22+ is required." \
        "Option 1: Install nvm — curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash\nOption 2: Install Homebrew — https://brew.sh\nThen run this installer again."
  fi
fi

# pnpm check
if command -v pnpm &>/dev/null; then
  PNPM_VERSION=$(pnpm -v 2>/dev/null || echo "unknown")
  animated_check "pnpm v${PNPM_VERSION}" 0.3
else
  info "Installing pnpm via corepack..."
  (corepack enable 2>/dev/null && corepack prepare pnpm@latest --activate 2>/dev/null) &
  COREPACK_PID=$!
  if ! spinner $COREPACK_PID "Installing pnpm via corepack..."; then
    info "Corepack failed, trying npm..."
    npm install -g pnpm &>/dev/null &
    spinner $! "Installing pnpm via npm..."
  fi
  if command -v pnpm &>/dev/null; then
    success "pnpm installed (v$(pnpm -v 2>/dev/null))"
  else
    die "Failed to install pnpm." "Try manually: npm install -g pnpm"
  fi
fi

# ─── 2. Install Dependencies ────────────────────────────────────────

section "Installing Dependencies"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info "Running pnpm install in ${DIM}$(basename "$SCRIPT_DIR")${NC}"
echo ""

# Run pnpm install with progress bar
(pnpm install --frozen-lockfile 2>/dev/null || pnpm install 2>/dev/null) &
INSTALL_PID=$!
progress_bar $INSTALL_PID "Installing packages..."

echo ""
success "All dependencies installed"

# ─── 3. Build Project ───────────────────────────────────────────────

section "Building Project"

pnpm run build &>/dev/null 2>&1 &
spinner $! "Compiling TypeScript..."

# ─── 4. Create Directories ──────────────────────────────────────────

section "Setting Up Directories"

mkdir -p ~/.nexus/{logs,screenshots,data}
animated_check "Created ~/.nexus/ directory structure" 0.3

# ─── 5. Launch Setup Wizard ─────────────────────────────────────────

section "Interactive Setup"

echo -e "  ${BOLD}Launching the NEXUS setup wizard...${NC}"
echo -e "  ${DIM}This will configure your Telegram bot, AI providers, and agents.${NC}"
echo ""
sleep 0.5

# Launch the TypeScript setup wizard
pnpm exec tsx scripts/setup.ts

WIZARD_EXIT=$?

if [ $WIZARD_EXIT -ne 0 ]; then
  echo ""
  warn "Setup wizard exited with an error."
  info "You can re-run it anytime with: ${BOLD}pnpm setup${NC}"
  echo ""
fi

# ─── 6. Final Banner ────────────────────────────────────────────────

echo ""
echo ""
echo -e "${BOLD}${C1}    ███╗   ██╗${C2}███████╗${C3}██╗  ██╗${C4}██╗   ██╗${C5}███████╗${NC}"
echo -e "${BOLD}${C1}    ████╗  ██║${C2}██╔════╝${C3}╚██╗██╔╝${C4}██║   ██║${C5}██╔════╝${NC}"
echo -e "${BOLD}${C2}    ██╔██╗ ██║${C3}█████╗  ${C4} ╚███╔╝ ${C5}██║   ██║${C6}███████╗${NC}"
echo -e "${BOLD}${C3}    ██║╚██╗██║${C4}██╔══╝  ${C5} ██╔██╗ ${C6}██║   ██║${C7}╚════██║${NC}"
echo -e "${BOLD}${C4}    ██║ ╚████║${C5}███████╗${C6}██╔╝ ╚██╗${C7}╚██████╔╝${C8}███████║${NC}"
echo -e "${BOLD}${C5}    ╚═╝  ╚═══╝${C6}╚══════╝${C7}╚═╝   ╚═╝${C7} ╚═════╝ ${C8}╚══════╝${NC}"
echo ""
echo -e "    ${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "    ${GREEN}${BOLD}║                                                  ║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${C6}✨  NEXUS is installed and ready!${NC}              ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║                                                  ║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${BOLD}Start:${NC}    ${CYAN}pnpm dev${NC}                             ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${BOLD}Prod:${NC}     ${CYAN}pnpm start${NC}                           ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${BOLD}Config:${NC}   ${DIM}~/.nexus/config.json${NC}                 ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${BOLD}Re-setup:${NC} ${CYAN}pnpm setup${NC}                           ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║                                                  ║${NC}"
echo -e "    ${GREEN}${BOLD}║${NC}   ${DIM}Open Telegram and send /start to your bot.${NC}     ${GREEN}${BOLD}║${NC}"
echo -e "    ${GREEN}${BOLD}║                                                  ║${NC}"
echo -e "    ${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "    ${DIM}NEXUS — Not an assistant. A presence.${NC}"
echo ""
