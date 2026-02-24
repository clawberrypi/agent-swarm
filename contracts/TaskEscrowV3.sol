// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title TaskEscrowV3
 * @notice Milestone-based escrow for agent swarm tasks.
 *         Extends V2 with multi-milestone support:
 *         - Lock total amount, release in phases
 *         - Each milestone has its own amount and deadline
 *         - Dispute resolution per milestone
 *         - All V2 security: reentrancy guard, safe transfers, arbitrator, timeout
 *
 * Flow:
 *   1. Requestor creates milestone escrow (deposits total USDC)
 *   2. Worker completes milestone N
 *   3. Requestor releases milestone N (worker gets paid for that phase)
 *   4. Repeat until all milestones released
 *   5. Either party can dispute any active milestone
 */
contract TaskEscrowV3 {

    enum MilestoneStatus { Active, Released, Disputed, Refunded }

    struct Milestone {
        uint256 amount;
        uint256 deadline;
        MilestoneStatus status;
        uint256 disputeTimestamp;
    }

    struct Escrow {
        address requestor;
        address worker;
        uint256 totalAmount;
        uint256 milestoneCount;
        uint256 releasedCount;
        bool exists;
    }

    IERC20 public immutable usdc;
    address public arbitrator;
    address public owner;

    uint256 public disputeTimeout = 7 days;
    uint256 public constant MIN_DISPUTE_TIMEOUT = 1 days;
    uint256 public constant MAX_DISPUTE_TIMEOUT = 90 days;
    uint256 public constant MAX_MILESTONES = 20;

    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => mapping(uint256 => Milestone)) public milestones;

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

    // ─── Events ───

    event MilestoneEscrowCreated(bytes32 indexed taskId, address requestor, address worker, uint256 totalAmount, uint256 milestoneCount);
    event MilestoneReleased(bytes32 indexed taskId, uint256 indexed milestoneIndex, address worker, uint256 amount);
    event MilestoneDisputed(bytes32 indexed taskId, uint256 indexed milestoneIndex, address disputedBy);
    event MilestoneRefunded(bytes32 indexed taskId, uint256 indexed milestoneIndex, address requestor, uint256 amount);
    event DisputeResolved(bytes32 indexed taskId, uint256 indexed milestoneIndex, bool releasedToWorker, address resolvedBy);
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

    // ─── Core ───

    /**
     * @notice Create a milestone escrow. Locks total USDC for all milestones.
     * @param taskId       Unique task identifier (bytes32)
     * @param worker       Worker address
     * @param amounts      Array of USDC amounts per milestone
     * @param deadlines    Array of deadlines per milestone (unix timestamps)
     */
    function createMilestoneEscrow(
        bytes32 taskId,
        address worker,
        uint256[] calldata amounts,
        uint256[] calldata deadlines
    ) external nonReentrant {
        require(!escrows[taskId].exists, "escrow exists");
        require(worker != address(0), "zero worker");
        require(worker != msg.sender, "worker is requestor");
        require(amounts.length > 0 && amounts.length <= MAX_MILESTONES, "invalid milestone count");
        require(amounts.length == deadlines.length, "length mismatch");

        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "zero milestone amount");
            require(deadlines[i] > block.timestamp, "deadline passed");
            if (i > 0) require(deadlines[i] >= deadlines[i-1], "deadlines not ascending");
            total += amounts[i];

            milestones[taskId][i] = Milestone({
                amount: amounts[i],
                deadline: deadlines[i],
                status: MilestoneStatus.Active,
                disputeTimestamp: 0
            });
        }

        escrows[taskId] = Escrow({
            requestor: msg.sender,
            worker: worker,
            totalAmount: total,
            milestoneCount: amounts.length,
            releasedCount: 0,
            exists: true
        });

        _safeTransferFrom(msg.sender, address(this), total);
        emit MilestoneEscrowCreated(taskId, msg.sender, worker, total, amounts.length);
    }

    /**
     * @notice Release a specific milestone to the worker.
     */
    function releaseMilestone(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(msg.sender == e.requestor, "not requestor");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");

        m.status = MilestoneStatus.Released;
        e.releasedCount++;
        _safeTransfer(e.worker, m.amount);
        emit MilestoneReleased(taskId, milestoneIndex, e.worker, m.amount);
    }

    /**
     * @notice Dispute a specific milestone.
     */
    function disputeMilestone(bytes32 taskId, uint256 milestoneIndex) external {
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(msg.sender == e.requestor || msg.sender == e.worker, "not party");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");

        m.status = MilestoneStatus.Disputed;
        m.disputeTimestamp = block.timestamp;
        emit MilestoneDisputed(taskId, milestoneIndex, msg.sender);
    }

    /**
     * @notice Arbitrator resolves a milestone dispute.
     */
    function resolveDisputeMilestone(bytes32 taskId, uint256 milestoneIndex, bool releaseToWorker) external nonReentrant {
        require(msg.sender == arbitrator, "not arbitrator");
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "not disputed");

        if (releaseToWorker) {
            m.status = MilestoneStatus.Released;
            e.releasedCount++;
            _safeTransfer(e.worker, m.amount);
            emit MilestoneReleased(taskId, milestoneIndex, e.worker, m.amount);
        } else {
            m.status = MilestoneStatus.Refunded;
            _safeTransfer(e.requestor, m.amount);
            emit MilestoneRefunded(taskId, milestoneIndex, e.requestor, m.amount);
        }
        emit DisputeResolved(taskId, milestoneIndex, releaseToWorker, msg.sender);
    }

    /**
     * @notice Requestor claims refund on disputed milestone after timeout.
     */
    function claimMilestoneTimeout(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(msg.sender == e.requestor, "not requestor");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "not disputed");
        require(block.timestamp >= m.disputeTimestamp + disputeTimeout, "timeout not reached");

        m.status = MilestoneStatus.Refunded;
        _safeTransfer(e.requestor, m.amount);
        emit MilestoneRefunded(taskId, milestoneIndex, e.requestor, m.amount);
    }

    /**
     * @notice Release milestone after its deadline passes (requestor only).
     */
    function releaseAfterDeadline(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(msg.sender == e.requestor, "not requestor");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");
        require(block.timestamp >= m.deadline, "deadline not reached");

        m.status = MilestoneStatus.Released;
        e.releasedCount++;
        _safeTransfer(e.worker, m.amount);
        emit MilestoneReleased(taskId, milestoneIndex, e.worker, m.amount);
    }

    /**
     * @notice Refund an active milestone after deadline (requestor only).
     */
    function refundMilestone(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Escrow storage e = escrows[taskId];
        require(e.exists, "no escrow");
        require(msg.sender == e.requestor, "not requestor");
        require(milestoneIndex < e.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");
        require(block.timestamp >= m.deadline, "deadline not reached");

        m.status = MilestoneStatus.Refunded;
        _safeTransfer(e.requestor, m.amount);
        emit MilestoneRefunded(taskId, milestoneIndex, e.requestor, m.amount);
    }

    // ─── Views ───

    function getEscrow(bytes32 taskId) external view returns (
        address requestor, address worker, uint256 totalAmount,
        uint256 milestoneCount, uint256 releasedCount, bool exists_
    ) {
        Escrow storage e = escrows[taskId];
        return (e.requestor, e.worker, e.totalAmount, e.milestoneCount, e.releasedCount, e.exists);
    }

    function getMilestone(bytes32 taskId, uint256 index) external view returns (
        uint256 amount, uint256 deadline, MilestoneStatus status_, uint256 disputeTimestamp
    ) {
        Milestone storage m = milestones[taskId][index];
        return (m.amount, m.deadline, m.status, m.disputeTimestamp);
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
