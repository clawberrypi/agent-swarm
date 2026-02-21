// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TaskEscrow
 * @notice Minimal escrow for agent-to-agent task payments.
 *         Zero fees. Lock, release, refund. That's it.
 */
contract TaskEscrow {
    enum Status { None, Active, Released, Disputed, Refunded }

    struct Escrow {
        address requestor;
        address worker;
        uint256 amount;
        uint256 deadline;
        Status status;
    }

    IERC20 public immutable usdc;
    mapping(bytes32 => Escrow) public escrows;

    event EscrowCreated(bytes32 indexed taskId, address requestor, address worker, uint256 amount, uint256 deadline);
    event EscrowReleased(bytes32 indexed taskId, address worker, uint256 amount);
    event EscrowDisputed(bytes32 indexed taskId, address disputedBy);
    event EscrowRefunded(bytes32 indexed taskId, address requestor, uint256 amount);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    /**
     * @notice Requestor deposits USDC into escrow for a task.
     * @param taskId Unique task identifier (hashed off-chain)
     * @param worker Worker's address
     * @param amount USDC amount (6 decimals)
     * @param deadline Unix timestamp: auto-release after this if requestor doesn't act
     */
    function createEscrow(bytes32 taskId, address worker, uint256 amount, uint256 deadline) external {
        require(escrows[taskId].status == Status.None, "escrow exists");
        require(worker != address(0), "zero worker");
        require(amount > 0, "zero amount");
        require(deadline > block.timestamp, "deadline passed");

        usdc.transferFrom(msg.sender, address(this), amount);

        escrows[taskId] = Escrow({
            requestor: msg.sender,
            worker: worker,
            amount: amount,
            deadline: deadline,
            status: Status.Active
        });

        emit EscrowCreated(taskId, msg.sender, worker, amount, deadline);
    }

    /**
     * @notice Requestor releases funds to the worker. Job done.
     */
    function releaseEscrow(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");

        e.status = Status.Released;
        usdc.transfer(e.worker, e.amount);

        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    /**
     * @notice Either party flags a dispute. Funds stay locked.
     */
    function dispute(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor || msg.sender == e.worker, "not party");

        e.status = Status.Disputed;

        emit EscrowDisputed(taskId, msg.sender);
    }

    /**
     * @notice Auto-release to worker if requestor doesn't act by deadline.
     *         Anyone can call this after the deadline.
     */
    function autoRelease(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(block.timestamp >= e.deadline, "deadline not reached");

        e.status = Status.Released;
        usdc.transfer(e.worker, e.amount);

        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    /**
     * @notice Requestor reclaims funds after deadline if worker never delivered.
     *         Only works if status is still Active (no result submitted).
     */
    function refund(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        require(block.timestamp >= e.deadline, "deadline not reached");

        e.status = Status.Refunded;
        usdc.transfer(e.requestor, e.amount);

        emit EscrowRefunded(taskId, e.requestor, e.amount);
    }
}
