#!/bin/bash

# Wrapper script for running Slither
# This ensures the venv is activated and solc is configured

set -e

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Activate venv
if [ -d "$PROJECT_DIR/venv" ]; then
    source "$PROJECT_DIR/venv/bin/activate"
else
    echo "❌ Error: Virtual environment not found. Run 'npm run audit:setup' first."
    exit 1
fi

# Set Solidity version
export SOLC_VERSION=0.8.22

# Check if slither is installed
if ! command -v slither &> /dev/null; then
    echo "❌ Error: Slither not found. Run 'npm run audit:setup' first."
    exit 1
fi

# Change to project directory
cd "$PROJECT_DIR"

# Run slither with provided arguments or default
# Use Hardhat compilation to handle dependencies properly
if [ $# -eq 0 ]; then
    # Default: use Hardhat compilation (Slither auto-detects Hardhat projects)
    slither . --exclude testing --exclude-dependencies
else
    slither "$@"
fi

