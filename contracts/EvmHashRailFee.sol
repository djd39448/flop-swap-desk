// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @notice Fee-bearing variant of `EvmHashRail` (F2a; FEES-PLAN-2026-09-19.md §1.2).
///
/// Derived from `contracts/EvmHashRail.sol` as vendored from tclk#21 @ d6477ac0aba7827a23bc
/// 77c72980dfc154c24e76 (git blob e4c328b2abf44f8ab12d14d168af22ecfc820652, see
/// PROVENANCE.md). Every line of `lock` and `refund` is identical to that source. The only
/// differences from it are:
///   - two new immutables, `feeBps` and `feeRecipient`, set once in the constructor and never
///     changed after (no admin, no setter, no upgrade, no pause — exactly as upstream);
///   - a `feeFor(amount)` view computing `floor(amount * feeBps / 10000)`;
///   - `claim` splits `held.amount` between the payee (`amount - fee`) and `feeRecipient`
///     (`fee`) in the same transaction that upstream pays only the payee; `Claimed` now
///     carries `fee`.
/// Every upstream revert string is kept verbatim; the only new strings are the two
/// constructor requires and the fee-transfer failure below. A zero-fee deployment (`feeBps_
/// == 0`) behaves exactly like the unmodified upstream contract: `feeFor` always returns 0,
/// the `if (fee > 0)` branch never fires, and the payee is paid `held.amount` in full.
contract EvmHashRailFee {
    enum Status {
        None,
        Locked,
        Claimed,
        Refunded
    }

    struct Lock {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 claimByMs;
        uint256 refundAfterMs;
        Status status;
    }

    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    mapping(bytes32 => Lock) public locks;

    event Locked(
        bytes32 indexed hashLock,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 claimByMs,
        uint256 refundAfterMs
    );
    event Claimed(bytes32 indexed hashLock, bytes32 preimage, uint256 fee);
    event Refunded(bytes32 indexed hashLock);

    constructor(uint16 feeBps_, address feeRecipient_) {
        require(feeBps_ <= 10000, "EvmHashRailFee: feeBps over 10000");
        require(feeRecipient_ != address(0), "EvmHashRailFee: feeRecipient is zero address");
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice `floor(amount * feeBps / 10000)`. Integer division floors; the remainder stays
    /// with the payee, never the recipient.
    function feeFor(uint256 amount) public view returns (uint256) {
        return amount * feeBps / 10000;
    }

    /// @notice Escrow `amount` of `token` under `hashLock`, callable by the payer.
    /// Pulls funds via `transferFrom` — the payer must approve this contract first.
    function lock(
        bytes32 hashLock,
        address payee,
        uint256 amount,
        address token,
        uint256 claimByMs,
        uint256 refundAfterMs
    ) external {
        require(locks[hashLock].status == Status.None, "EvmHashRail: lock exists");
        require(payee != address(0), "EvmHashRail: payee is zero address");
        require(amount > 0, "EvmHashRail: amount is zero");
        require(claimByMs < refundAfterMs, "EvmHashRail: claimByMs must precede refundAfterMs");
        require(
            block.timestamp * 1000 < refundAfterMs,
            "EvmHashRail: refusing to lock into an already-open refund window"
        );

        locks[hashLock] = Lock({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            claimByMs: claimByMs,
            refundAfterMs: refundAfterMs,
            status: Status.Locked
        });

        emit Locked(hashLock, msg.sender, payee, token, amount, claimByMs, refundAfterMs);

        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "EvmHashRail: transferFrom failed"
        );
    }

    /// @notice Release to the payee, minus the fee, which moves to `feeRecipient` in the same
    /// transaction. Permissionless — anyone may relay the preimage, funds only ever move to
    /// the `payee` and `feeRecipient` addresses fixed at lock/deploy time.
    function claim(bytes32 hashLock, bytes32 preimage) external {
        Lock storage held = locks[hashLock];
        require(held.status != Status.None, "EvmHashRail: claim on an unknown lock");
        require(held.status == Status.Locked, "EvmHashRail: claim on a lock that is not locked");
        require(block.timestamp * 1000 < held.refundAfterMs, "EvmHashRail: claim after refundAfterMs");
        require(sha256(abi.encodePacked(preimage)) == hashLock, "EvmHashRail: secret does not open the statement");

        held.status = Status.Claimed;
        uint256 fee = feeFor(held.amount);
        uint256 net = held.amount - fee;
        emit Claimed(hashLock, preimage, fee);

        require(IERC20(held.token).transfer(held.payee, net), "EvmHashRail: transfer failed");
        if (fee > 0) {
            require(IERC20(held.token).transfer(feeRecipient, fee), "EvmHashRail: fee transfer failed");
        }
    }

    /// @notice Return to the payer, only at/after `refundAfterMs`, only the payer. No fee is
    /// ever taken on a refund.
    function refund(bytes32 hashLock) external {
        Lock storage held = locks[hashLock];
        require(held.status != Status.None, "EvmHashRail: refund on an unknown lock");
        require(held.status == Status.Locked, "EvmHashRail: refund on a lock that is not locked");
        require(msg.sender == held.payer, "EvmHashRail: only the payer refunds");
        require(block.timestamp * 1000 >= held.refundAfterMs, "EvmHashRail: refund before refundAfterMs");

        held.status = Status.Refunded;
        emit Refunded(hashLock);

        require(IERC20(held.token).transfer(held.payer, held.amount), "EvmHashRail: transfer failed");
    }
}
