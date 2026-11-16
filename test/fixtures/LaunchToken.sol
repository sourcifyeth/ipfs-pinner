// SPDX-License-Identifier: MIT

/*//////////////////////////////////////////////////////////////////////////////

    Launched on Stockereum.fun - #1 Meme/Stocks Launchpad on Ethereum

//////////////////////////////////////////////////////////////////////////////*/

pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHolderDistributor} from "./interfaces/IHolderDistributor.sol";

contract LaunchToken is ERC20 {
    string public constant DESCRIPTION = "Launched on Stockereum.fun - #1 Meme/Stocks Launchpad on Ethereum";

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    address public immutable creator;
    address public immutable factory;
    address public immutable distributor;

    string public metadataUri;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataUri_,
        address creator_,
        address recipient,
        address distributor_
    ) ERC20(name_, symbol_) {
        metadataUri = metadataUri_;
        creator = creator_;
        factory = msg.sender;
        distributor = distributor_;
        _mint(recipient, TOTAL_SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && distributor != address(0)) {
            IHolderDistributor(distributor).onTransfer(from, to, value, balanceOf(from), balanceOf(to));
        }
    }
}
