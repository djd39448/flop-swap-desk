// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EvmHashRailFee} from "../contracts/EvmHashRailFee.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

/// @notice Fee math, rounding, the Claimed event and refund behaviour across a range of
/// `feeBps` values. Each test deploys its own EvmHashRailFee instance (bps varies per test),
/// unlike EvmHashRailFeeZeroFeeTest below where every test shares one zero-fee deployment.
contract EvmHashRailFeeTest is Test {
    MockERC20 token;

    address payer = makeAddr("payer");
    address payee = makeAddr("payee");

    bytes32 preimage = keccak256("tclk-issue12-and-friends-fee");
    bytes32 hashLock;

    uint256 claimByMs;
    uint256 refundAfterMs;

    function setUp() public {
        token = new MockERC20();
        hashLock = sha256(abi.encodePacked(preimage));

        // Anchor deadlines to the current block time (in ms), as the vendored test does.
        claimByMs = block.timestamp * 1000 + 3_600_000;
        refundAfterMs = block.timestamp * 1000 + 7_200_000;
    }

    function _deployAndLock(uint16 feeBps_, uint256 amount, string memory recipientLabel)
        internal
        returns (EvmHashRailFee rail, address recipient)
    {
        recipient = makeAddr(recipientLabel);
        rail = new EvmHashRailFee(feeBps_, recipient);

        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(rail), amount);
        vm.prank(payer);
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    function _claimAndCheck(uint16 feeBps_, uint256 amount, uint256 expectedPayee, uint256 expectedRecipient)
        internal
    {
        (EvmHashRailFee rail, address recipient) =
            _deployAndLock(feeBps_, amount, string.concat("recipient-", vm.toString(feeBps_), "-", vm.toString(amount)));

        rail.claim(hashLock, preimage);

        assertEq(token.balanceOf(payee), expectedPayee);
        assertEq(token.balanceOf(recipient), expectedRecipient);
        assertEq(token.balanceOf(address(rail)), 0);
    }

    // --- constructor ---

    function test_constructor_feeBpsOver10000_reverts() public {
        vm.expectRevert("EvmHashRailFee: feeBps over 10000");
        new EvmHashRailFee(10001, makeAddr("recipient"));
    }

    function test_constructor_zeroFeeRecipient_reverts() public {
        vm.expectRevert("EvmHashRailFee: feeRecipient is zero address");
        new EvmHashRailFee(25, address(0));
    }

    function test_constructor_setsFeeBpsAndFeeRecipient() public {
        address recipient = makeAddr("recipient-ctor");
        EvmHashRailFee rail = new EvmHashRailFee(25, recipient);
        assertEq(rail.feeBps(), 25);
        assertEq(rail.feeRecipient(), recipient);
    }

    // --- fee math, amount = 1_000_000, across the declared bps range ---

    function test_feeMath_amount1e6_bps0() public {
        _claimAndCheck(0, 1_000_000, 1_000_000, 0);
    }

    function test_feeMath_amount1e6_bps1() public {
        _claimAndCheck(1, 1_000_000, 999_900, 100);
    }

    function test_feeMath_amount1e6_bps25() public {
        _claimAndCheck(25, 1_000_000, 997_500, 2_500);
    }

    function test_feeMath_amount1e6_bps100() public {
        _claimAndCheck(100, 1_000_000, 990_000, 10_000);
    }

    function test_feeMath_amount1e6_bps10000() public {
        _claimAndCheck(10000, 1_000_000, 0, 1_000_000);
    }

    // --- rounding: floor(amount * feeBps / 10000), remainder stays with the payee ---

    function test_rounding_amount1_bps25_feeFloorsToZero() public {
        _claimAndCheck(25, 1, 1, 0);
    }

    function test_rounding_amount1_bps10000_feeIsTheWholeAmount() public {
        _claimAndCheck(10000, 1, 0, 1);
    }

    function test_rounding_amount999_bps100() public {
        _claimAndCheck(100, 999, 990, 9);
    }

    function test_rounding_amount40001_bps25() public {
        _claimAndCheck(25, 40_001, 39_901, 100);
    }

    // --- Claimed event ---

    function test_claim_emitsClaimedWithFee() public {
        (EvmHashRailFee rail,) = _deployAndLock(25, 1_000_000, "recipient-event");

        vm.expectEmit(true, false, false, true, address(rail));
        emit EvmHashRailFee.Claimed(hashLock, preimage, 2_500);
        rail.claim(hashLock, preimage);
    }

    // --- refund: always the full amount, the fee recipient is never touched ---

    function test_refund_bps25_returnsFullAmount_recipientUntouched() public {
        (EvmHashRailFee rail, address recipient) = _deployAndLock(25, 1_000_000, "recipient-refund-25");

        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        rail.refund(hashLock);

        assertEq(token.balanceOf(payer), 1_000_000);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(address(rail)), 0);
    }

    function test_refund_bps10000_returnsFullAmount_recipientUntouched() public {
        (EvmHashRailFee rail, address recipient) = _deployAndLock(10000, 1_000_000, "recipient-refund-10000");

        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        rail.refund(hashLock);

        assertEq(token.balanceOf(payer), 1_000_000);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(address(rail)), 0);
    }
}

/// @notice At feeBps == 0, EvmHashRailFee must behave exactly like the unmodified upstream
/// EvmHashRail: this mirrors test/EvmHashRail.t.sol's own happy path and guards (same revert
/// strings, same permissionless claim, same deadline rules), plus the fee recipient balance
/// staying untouched throughout.
contract EvmHashRailFeeZeroFeeTest is Test {
    EvmHashRailFee rail;
    MockERC20 token;

    address feeRecipient = makeAddr("feeRecipientZero");
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    bytes32 preimage = keccak256("tclk-issue12-and-friends-fee-zero");
    bytes32 hashLock;

    uint256 amount = 1_000_000;
    uint256 claimByMs;
    uint256 refundAfterMs;

    function setUp() public {
        rail = new EvmHashRailFee(0, feeRecipient);
        token = new MockERC20();
        hashLock = sha256(abi.encodePacked(preimage));

        claimByMs = block.timestamp * 1000 + 3_600_000;
        refundAfterMs = block.timestamp * 1000 + 7_200_000;

        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(rail), amount);
    }

    function _lock() internal {
        vm.prank(payer);
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    function test_zeroFee_lockThenClaim_movesFullAmountToPayee() public {
        _lock();
        assertEq(token.balanceOf(address(rail)), amount);
        assertEq(token.balanceOf(payer), 0);

        rail.claim(hashLock, preimage);

        assertEq(token.balanceOf(payee), amount);
        assertEq(token.balanceOf(feeRecipient), 0);
        assertEq(token.balanceOf(address(rail)), 0);
        (,,,,,, EvmHashRailFee.Status status) = rail.locks(hashLock);
        assertEq(uint8(status), uint8(EvmHashRailFee.Status.Claimed));
    }

    function test_zeroFee_claim_isPermissionless() public {
        _lock();
        vm.prank(stranger);
        rail.claim(hashLock, preimage);
        assertEq(token.balanceOf(payee), amount);
        assertEq(token.balanceOf(feeRecipient), 0);
    }

    function test_zeroFee_claim_withWrongPreimage_reverts() public {
        _lock();
        vm.expectRevert("EvmHashRail: secret does not open the statement");
        rail.claim(hashLock, keccak256("wrong secret"));
    }

    function test_zeroFee_claim_afterRefundWindowOpens_reverts() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.expectRevert("EvmHashRail: claim after refundAfterMs");
        rail.claim(hashLock, preimage);
    }

    function test_zeroFee_refund_beforeWindow_reverts() public {
        _lock();
        vm.prank(payer);
        vm.expectRevert("EvmHashRail: refund before refundAfterMs");
        rail.refund(hashLock);
    }

    function test_zeroFee_refund_byNonPayer_reverts() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.expectRevert("EvmHashRail: only the payer refunds");
        vm.prank(stranger);
        rail.refund(hashLock);
    }

    function test_zeroFee_lock_duplicateHashLock_reverts() public {
        _lock();
        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(rail), amount);

        vm.prank(payer);
        vm.expectRevert("EvmHashRail: lock exists");
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    function test_zeroFee_lock_intoAlreadyOpenRefundWindow_reverts() public {
        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        vm.expectRevert("EvmHashRail: refusing to lock into an already-open refund window");
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }
}
