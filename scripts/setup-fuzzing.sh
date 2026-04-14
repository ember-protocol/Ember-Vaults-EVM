#!/bin/bash

# =============================================================================
# Fuzzing Setup Script for EmberVault
# =============================================================================
# This script helps set up and run fuzz testing tools (Foundry & Echidna)
# =============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# =============================================================================
# Check if Foundry is installed
# =============================================================================
check_foundry() {
    print_header "Checking Foundry Installation"
    
    if command -v forge &> /dev/null; then
        local version=$(forge --version | head -n 1)
        print_success "Foundry is installed: $version"
        
        # Check if forge-std is installed
        if [ -d "lib/forge-std" ]; then
            print_success "forge-std library is installed"
        else
            print_warning "forge-std library is NOT installed"
            print_info "Run: forge install foundry-rs/forge-std --no-commit"
        fi
        return 0
    else
        print_warning "Foundry is not installed"
        return 1
    fi
}

# =============================================================================
# Install Foundry
# =============================================================================
install_foundry() {
    print_header "Installing Foundry"
    
    print_info "Downloading Foundry installer..."
    curl -L https://foundry.paradigm.xyz | bash
    
    print_info "Running foundryup..."
    source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
    foundryup
    
    print_success "Foundry installed successfully!"
    
    # Install forge-std library
    print_info "Installing forge-std library..."
    if [ ! -d "lib/forge-std" ]; then
        forge install foundry-rs/forge-std --no-commit
        print_success "forge-std installed successfully!"
    else
        print_success "forge-std already installed"
    fi
}

# =============================================================================
# Check if Echidna is installed
# =============================================================================
check_echidna() {
    print_header "Checking Echidna Installation"
    
    if command -v echidna-test &> /dev/null; then
        local version=$(echidna-test --version 2>&1 | head -n 1)
        print_success "Echidna is installed: $version"
        return 0
    else
        print_warning "Echidna is not installed"
        return 1
    fi
}

# =============================================================================
# Install Echidna
# =============================================================================
install_echidna() {
    print_header "Installing Echidna"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            print_info "Installing Echidna via Homebrew..."
            brew install echidna
            print_success "Echidna installed successfully!"
        else
            print_error "Homebrew not found. Please install Homebrew first:"
            print_info "Visit: https://brew.sh"
            return 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        print_info "Installing Echidna via binary download..."
        local LATEST=$(curl -s https://api.github.com/repos/crytic/echidna/releases/latest | grep "tag_name" | cut -d '"' -f 4)
        wget "https://github.com/crytic/echidna/releases/download/${LATEST}/echidna-test-${LATEST}-Linux.tar.gz"
        tar -xzf "echidna-test-${LATEST}-Linux.tar.gz"
        sudo mv echidna-test /usr/local/bin/
        rm "echidna-test-${LATEST}-Linux.tar.gz"
        print_success "Echidna installed successfully!"
    else
        print_error "Unsupported OS. Please install Echidna manually:"
        print_info "Visit: https://github.com/crytic/echidna"
        return 1
    fi
}

# =============================================================================
# Run Foundry Fuzz Tests
# =============================================================================
run_foundry_tests() {
    print_header "Running Foundry Fuzz Tests"
    
    local runs=${1:-10000}
    
    print_info "Running fuzz tests with $runs runs..."
    forge test --match-contract Fuzz --fuzz-runs "$runs" -vv
    
    print_success "Foundry fuzz tests completed!"
}

# =============================================================================
# Run Echidna Tests
# =============================================================================
run_echidna_tests() {
    print_header "Running Echidna Property Tests"
    
    print_info "Running Echidna..."
    print_warning "Note: Echidna may take several minutes to complete"
    
    echidna-test . --contract EmberVaultProperties --config echidna.yaml
    
    print_success "Echidna tests completed!"
}

# =============================================================================
# Generate Coverage Report
# =============================================================================
generate_coverage() {
    print_header "Generating Coverage Report"
    
    print_info "Running tests with coverage..."
    forge coverage --match-contract Fuzz
    
    print_success "Coverage report generated!"
}

# =============================================================================
# Main Menu
# =============================================================================
show_menu() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║           EmberVault Fuzzing Test Suite                      ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Choose an option:"
    echo ""
    echo "  1) Check installations"
    echo "  2) Install Foundry"
    echo "  3) Install Echidna"
    echo "  4) Run Foundry fuzz tests (10k runs)"
    echo "  5) Run Foundry fuzz tests (100k runs)"
    echo "  6) Run Echidna property tests"
    echo "  7) Run all tests"
    echo "  8) Generate coverage report"
    echo "  9) Exit"
    echo ""
    read -p "Enter your choice [1-9]: " choice
}

# =============================================================================
# Main Script
# =============================================================================
main() {
    while true; do
        show_menu
        
        case $choice in
            1)
                check_foundry
                check_echidna
                ;;
            2)
                install_foundry
                ;;
            3)
                install_echidna
                ;;
            4)
                run_foundry_tests 10000
                ;;
            5)
                run_foundry_tests 100000
                ;;
            6)
                run_echidna_tests
                ;;
            7)
                run_foundry_tests 10000
                run_echidna_tests
                ;;
            8)
                generate_coverage
                ;;
            9)
                print_success "Goodbye!"
                exit 0
                ;;
            *)
                print_error "Invalid option. Please choose 1-9."
                ;;
        esac
        
        echo ""
        read -p "Press Enter to continue..."
    done
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main
fi
