// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IQorePQC} from "../interfaces/IQorePQC.sol";

/// @notice Fail-closed wrappers around QoreChain's post-quantum precompiles.
/// @dev An inactive precompile returns empty data. Every wrapper treats a failed call or
/// short return data as "not valid" / "not registered", never as success.
library QorePQC {
    address internal constant VERIFY = address(0x0A01);
    address internal constant KEY_STATUS = address(0x0A02);

    /// @notice True only if the precompile answered and reported the signature valid.
    function verify(bytes memory pubkey, bytes memory signature, bytes memory message)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) = VERIFY.staticcall(
            abi.encodeWithSelector(IQorePQC.pqcVerify.selector, pubkey, signature, message)
        );
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /// @notice The registered key of `account`, or `registered == false` if there is none or
    /// the precompile did not answer.
    function keyStatus(address account)
        internal
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey)
    {
        (bool ok, bytes memory ret) =
            KEY_STATUS.staticcall(abi.encodeWithSelector(IQorePQC.pqcKeyStatus.selector, account));
        if (!ok || ret.length < 96) return (false, 0, "");
        return abi.decode(ret, (bool, uint8, bytes));
    }
}
