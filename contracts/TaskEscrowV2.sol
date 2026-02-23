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

    uint256 public disputeTimeout = 7 days;
    uint256 public constant MIN_DISPUTE_TIMEOUT = 1 days;
    uint256 public constant MAX_DISPUTE_TIMEOUT = 90 days;

    mapping(bytes32 => uint256) public disputeTimestamps;
    mapping(bytes32 => Escrow) public escrows;

    // ─── Reentrancy Guard ───
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_status != _ENTERED, "reentrant");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    event EscrowCreated(bytes32 indexed taskId, address requestor, address worker, uint256 amount, uint256 deadline);
    event EscrowReleased(bytes32 indexed taskId, address worker, uint256 amount);
    event EscrowDisputed(bytes32 indexed taskId, address disputedBy);
    event EscrowRefunded(bytes32 indexed taskId, address requestor, uint256 amount);
    event DisputeResolved(bytes32 indexed taskId, bool releasedToWorker, address resolvedBy);
    event ArbitratorChanged(address oldArbitrator, address newArbitrator);

    constructor(address _usdc, address _arbitrator) {
        require(_usdc != address(0), "zero usdc");
        require(_arbitrator != address(0), "zero arbitrator");
        usdc = IERC20(_usdc);
        arbitrator = _arbitrator;
        owner = msg.sender;
    }

    // ─── Safe Transfer Helpers ───

    function _safeTransfer(address to, uint256 amount) private {
        bool success = usdc.transfer(to, amount);
        require(success, "transfer failed");
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        bool success = usdc.transferFrom(from, to, amount);
        require(success, "transferFrom failed");
    }

    // ─── Core Escrow ───

    function createEscrow(bytes32 taskId, address worker, uint256 amount, uint256 deadline) external nonReentrant {
        require(escrows[taskId].status == Status.None, "escrow exists");
        require(worker != address(0), "zero worker");
        require(worker != msg.sender, "worker is requestor");
        require(amount > 0, "zero amount");
        require(deadline > block.timestamp, "deadline passed");

        escrows[taskId] = Escrow({
            requestor: msg.sender,
            worker: worker,
            amount: amount,
            deadline: deadline,
            status: Status.Active
        });

        _safeTransferFrom(msg.sender, address(this), amount);
        emit EscrowCreated(taskId, msg.sender, worker, amount, deadline);
    }

    /// @notice Requestor releases funds to worker (task completed satisfactorily).
    function releaseEscrow(bytes32 taskId) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        e.status = Status.Released;
        _safeTransfer(e.worker, e.amount);
        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    /// @notice Either party flags a dispute.
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
    function resolveDispute(bytes32 taskId, bool releaseToWorker) external nonReentrant {
        require(msg.sender == arbitrator, "not arbitrator");
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Disputed, "not disputed");

        if (releaseToWorker) {
            e.status = Status.Released;
            _safeTransfer(e.worker, e.amount);
            emit EscrowReleased(taskId, e.worker, e.amount);
        } else {
            e.status = Status.Refunded;
            _safeTransfer(e.requestor, e.amount);
            emit EscrowRefunded(taskId, e.requestor, e.amount);
        }
        emit DisputeResolved(taskId, releaseToWorker, msg.sender);
    }

    /// @notice If dispute is unresolved after disputeTimeout, requestor can claim refund.
    function claimDisputeTimeout(bytes32 taskId) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Disputed, "not disputed");
        require(msg.sender == e.requestor, "not requestor");
        require(block.timestamp >= disputeTimestamps[taskId] + disputeTimeout, "timeout not reached");
        e.status = Status.Refunded;
        _safeTransfer(e.requestor, e.amount);
        emit EscrowRefunded(taskId, e.requestor, e.amount);
    }

    // ─── Post-Deadline: Requestor Decides ───

    /// @notice After deadline, requestor can release funds to worker.
    function releaseAfterDeadline(bytes32 taskId) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        require(block.timestamp >= e.deadline, "deadline not reached");
        e.status = Status.Released;
        _safeTransfer(e.worker, e.amount);
        emit EscrowReleased(taskId, e.worker, e.amount);
    }

    /// @notice After deadline, requestor can reclaim funds.
    function refund(bytes32 taskId) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.status == Status.Active, "not active");
        require(msg.sender == e.requestor, "not requestor");
        require(block.timestamp >= e.deadline, "deadline not reached");
        e.status = Status.Refunded;
        _safeTransfer(e.requestor, e.amount);
        emit EscrowRefunded(taskId, e.requestor, e.amount);
    }

    // ─── Admin ───

    function setArbitrator(address _arbitrator) external onlyOwner {
        require(_arbitrator != address(0), "zero arbitrator");
        emit ArbitratorChanged(arbitrator, _arbitrator);
        arbitrator = _arbitrator;
    }

    function setDisputeTimeout(uint256 _timeout) external onlyOwner {
        require(_timeout >= MIN_DISPUTE_TIMEOUT, "below minimum");
        require(_timeout <= MAX_DISPUTE_TIMEOUT, "above maximum");
        disputeTimeout = _timeout;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
