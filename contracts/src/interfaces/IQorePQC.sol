// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice QoreChain's post-quantum precompile interface (IQorePQC), as published in the
/// IQORE_PQC_ABI export of the QoreChain EVM kit.
/// pqcVerify lives at 0x0A01 and pqcKeyStatus at 0x0A02; each address serves its function.
interface IQorePQC {
    /// @notice Verify a post-quantum signature over `message`.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// @notice The post-quantum key registered on chain for `account`.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey);
}
