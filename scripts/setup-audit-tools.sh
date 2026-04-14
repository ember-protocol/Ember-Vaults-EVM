#!/bin/bash

# Setup script for security audit tools
# This script sets up a Python virtual environment and installs audit tools

set -e

echo "🔒 Setting up Security Audit Tools for Ember Vaults"
echo "=================================================="
echo ""

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "📦 Creating Python virtual environment..."
    python3 -m venv venv
    echo "✅ Virtual environment created"
else
    echo "✅ Virtual environment already exists"
fi

# Activate venv
echo ""
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Upgrade pip
echo ""
echo "⬆️  Upgrading pip..."
pip install --upgrade pip

# Install Slither
echo ""
echo "📥 Installing Slither (Static Analysis)..."
pip install slither-analyzer

# Install solc-select for version management
echo ""
echo "📥 Installing solc-select (Solidity version manager)..."
pip install solc-select

# Initialize solc-select
echo ""
echo "🔧 Initializing solc-select..."
solc-select install 0.8.22
solc-select use 0.8.22
echo "✅ Solidity 0.8.22 installed and set as default"

echo ""
echo "✅ Setup complete!"
echo ""
echo "To use the tools:"
echo "  1. Activate the virtual environment: source venv/bin/activate"
echo "  2. Run Slither: slither contracts/ --exclude testing"
echo ""
echo "Or use the npm scripts:"
echo "  npm run audit:slither"

