// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract TaskEscrowV2 {
    enum Status { None, Active, Released, Disputed, Refunded }

    struct Escrow {
        address requestor;
        address worker;
        uint256 amount;
        uint256 deadline;
        Status status;
    }

    IERC20 public immutable usdc;
    address public arbitrator;
    address public owner;

    /// @notice Default dispute window: if disputed and unresolved after this many seconds, 
    /// requestor can claim a refund. Default 7 days.
    uint256 public disputeTimeout = 7 days;

    /// @notice Timestamp when a dispute was filed (taskId => timestamp)
    mapping(bytes32 => uint256) public disputeTimestamps;

    mapping(bytes32 => Escrow) public escrows;

    event EscrowCreated(bytes32 indexed taskId, address requestor, address worker, uint256 amount, uint256 deadline);
    event EscrowReleased(bytes32 indexed taskId, address worker, uint256 amount);
    event EscrowDisputed(bytes32 indexed taskId, address disputedBy);
    event EscrowRefunded(bytes32 indexed taskId, address requestor, uint256 amount);
    event DisputeResolved(bytes32 indexed taskId, bool releasedToWorker, address resolvedBy);
    event ArbitratorChanged(address oldArbitrator, address newArbitrator);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdc, address _arbitrator) {
        usdc = IERC20(_usdc);
        arbitrator = _arbitrator;
        owner = msg.sender;
    }

    // ─── Core Escrow ───

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

    function releaseEscrow(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        e.status = Status.Released;
        usdc.transfer(e.worker, e.amount);
        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    function dispute(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor || msg.sender == e.worker, "not party");
        e.status = Status.Disputed;
        disputeTimestamps[taskId] = block.timestamp;
        emit EscrowDisputed(taskId, msg.sender);
    }

    // ─── Dispute Resolution ───

    /// @notice Arbitrator resolves a dispute. Sends funds to worker (true) or requestor (false).
    function resolveDispute(bytes32 taskId, bool releaseToWorker) external {
        require(msg.sender == arbitrator, "not arbitrator");
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Disputed, "not disputed");

        if (releaseToWorker) {
            e.status = Status.Released;
            usdc.transfer(e.worker, e.amount);
            emit EscrowReleased(taskId, e.worker, e.amount);
        } else {
            e.status = Status.Refunded;
            usdc.transfer(e.requestor, e.amount);
            emit EscrowRefunded(taskId, e.requestor, e.amount);
        }
        emit DisputeResolved(taskId, releaseToWorker, msg.sender);
    }

    /// @notice If dispute is unresolved after disputeTimeout, requestor can claim refund.
    function claimDisputeTimeout(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Disputed, "not disputed");
        require(block.timestamp >= disputeTimestamps[taskId] + disputeTimeout, "timeout not reached");
        e.status = Status.Refunded;
        usdc.transfer(e.requestor, e.amount);
        emit EscrowRefunded(taskId, e.requestor, e.amount);
    }

    // ─── Auto-release / Refund (unchanged) ───

    function autoRelease(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(block.timestamp >= e.deadline, "deadline not reached");
        e.status = Status.Released;
        usdc.transfer(e.worker, e.amount);
        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    function refund(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        require(block.timestamp >= e.deadline, "deadline not reached");
        e.status = Status.Refunded;
        usdc.transfer(e.requestor, e.amount);
        emit EscrowRefunded(taskId, e.requestor, e.amount);
    }

    // ─── Admin ───

    function setArbitrator(address _arbitrator) external onlyOwner {
        emit ArbitratorChanged(arbitrator, _arbitrator);
        arbitrator = _arbitrator;
    }

    function setDisputeTimeout(uint256 _timeout) external onlyOwner {
        disputeTimeout = _timeout;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
