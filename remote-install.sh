#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
#  NEXUS AI — Remote Installer
#  Clones the repo and launches the full installer
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/blazelucastaco-ai/nexus/main/remote-install.sh | bash
# ──────────────────────────────────────────────────────────────────────

# ─── Colors ──────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

C1='\033[38;5;51m'
C2='\033[38;5;45m'
C3='\033[38;5;39m'
C4='\033[38;5;63m'
C5='\033[38;5;99m'
C6='\033[38;5;135m'
C7='\033[38;5;171m'
C8='\033[38;5;177m'

# ─── Logo ─────────────────────────────────────────────────────────────

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
  echo -e "    ${C4}Personal AI That Lives On Your Mac${NC}"
  echo -e "    ${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

success() { echo -e "  ${GREEN}✓${NC} $1"; }
error()   { echo -e "  ${RED}✗${NC} $1"; }
info()    { echo -e "  ${CYAN}ℹ${NC} $1"; }

die() {
  echo ""
  error "$1"
  echo -e "  ${DIM}$2${NC}"
  echo ""
  exit 1
}

# ─── Main ─────────────────────────────────────────────────────────────

show_logo

echo -e "  ${BOLD}Installing NEXUS on your Mac...${NC}"
echo ""

# Determine install location
INSTALL_DIR="${NEXUS_INSTALL_DIR:-$HOME/nexus}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "  ${YELLOW}⚠${NC}  Directory ${BOLD}${INSTALL_DIR}${NC} already exists."
  echo ""
  read -r -p "  Overwrite? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo ""
    info "To install elsewhere, set NEXUS_INSTALL_DIR before running:"
    echo -e "  ${DIM}NEXUS_INSTALL_DIR=~/my-nexus curl -fsSL ... | bash${NC}"
    echo ""
    exit 0
  fi
  rm -rf "$INSTALL_DIR"
fi

# Check for git
if ! command -v git &>/dev/null; then
  die "git is required but not found." \
      "Install Xcode Command Line Tools: xcode-select --install"
fi

# Check for macOS
if [[ "$(uname)" != "Darwin" ]]; then
  die "NEXUS requires macOS." \
      "Detected: $(uname). NEXUS uses macOS-specific APIs."
fi

# Clone the repo
echo ""
info "Cloning NEXUS into ${BOLD}${INSTALL_DIR}${NC}..."
echo ""

if ! git clone --depth 1 https://github.com/blazelucastaco-ai/nexus.git "$INSTALL_DIR" 2>&1; then
  die "Failed to clone repository." \
      "Check your internet connection and try again."
fi

echo ""
success "Repository cloned to ${INSTALL_DIR}"
echo ""

# Hand off to the local installer
cd "$INSTALL_DIR"
bash ./install.sh
