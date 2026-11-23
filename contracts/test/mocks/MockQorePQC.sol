// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQorePQC} from "../../src/interfaces/IQorePQC.sol";

/// @notice Test stand-in for QoreChain's PQC precompiles, etched at 0x0A01 and 0x0A02.
/// A "signature" is keccak256(pubkey ‖ message), so tests can produce valid and invalid
/// signatures. This models the precompile's interface only, not ML-DSA itself.
contract MockQorePQC is IQorePQC {
    struct Key {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
    }

    mapping(address => Key) internal keys;

    function setKey(address account, bool registered, uint8 algorithmId, bytes calldata pubkey)
        external
    {
        keys[account] = Key(registered, algorithmId, pubkey);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(signature) == keccak256(abi.encodePacked(sign(pubkey, message)));
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory) {
        Key storage k = keys[account];
        return (k.registered, k.algorithmId, k.pubkey);
    }

    function sign(bytes memory pubkey, bytes memory message) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(pubkey, message));
    }
}
