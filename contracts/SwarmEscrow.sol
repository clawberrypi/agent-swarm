// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title SwarmEscrow
 * @notice Multi-worker milestone escrow for collaborative agent tasks.
 *         Extends TaskEscrowV3 concepts with:
 *         - Multiple workers per task (different worker per milestone)
 *         - Bid-lock phase: task starts in Bidding state, requestor accepts bids before funding
 *         - Bid bonds: workers deposit small bond when bidding, returned if not selected
 *         - Coordinator pattern: one worker can be designated coordinator
 *         - All V3 security: reentrancy guard, safe transfers, arbitrator, timeouts
 *
 * Flow:
 *   1. Requestor creates task in Bidding state (no funds locked yet)
 *   2. Workers place bids with bond deposits
 *   3. Requestor accepts workers + assigns milestones, deposits total USDC
 *   4. Workers complete assigned milestones
 *   5. Requestor releases milestones (each pays its assigned worker)
 *   6. Non-selected bidders reclaim bonds
 */
contract SwarmEscrow {

    enum TaskStatus { Bidding, Active, Completed, Cancelled }
    enum MilestoneStatus { Unassigned, Active, Released, Disputed, Refunded }

    struct Task {
        address requestor;
        uint256 totalBudget;
        uint256 milestoneCount;
        uint256 releasedCount;
        uint256 bidDeadline;
        uint256 bondAmount;
        TaskStatus status;
        address coordinator;
        bool exists;
    }

    struct Milestone {
        address worker;
        uint256 amount;
        uint256 deadline;
        MilestoneStatus status;
        uint256 disputeTimestamp;
    }

    struct Bid {
        address worker;
        uint256 price;
        bool bonded;
        bool accepted;
        bool refunded;
    }

    IERC20 public immutable usdc;
    address public arbitrator;
    address public owner;

    uint256 public disputeTimeout = 7 days;
    uint256 public constant MIN_DISPUTE_TIMEOUT = 1 days;
    uint256 public constant MAX_DISPUTE_TIMEOUT = 90 days;
    uint256 public constant MAX_MILESTONES = 20;
    uint256 public constant MAX_BIDS = 50;

    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => mapping(uint256 => Milestone)) public milestones;
    mapping(bytes32 => Bid[]) public bids;
    mapping(bytes32 => mapping(address => uint256)) public bidIndex; // worker -> bid index + 1 (0 = no bid)

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
    event TaskCreated(bytes32 indexed taskId, address requestor, uint256 totalBudget, uint256 milestoneCount, uint256 bidDeadline);
    event BidPlaced(bytes32 indexed taskId, address indexed worker, uint256 price, uint256 bondAmount);
    event BidAccepted(bytes32 indexed taskId, address indexed worker);
    event BidBondRefunded(bytes32 indexed taskId, address indexed worker, uint256 amount);
    event TaskFunded(bytes32 indexed taskId, uint256 totalAmount);
    event MilestoneAssigned(bytes32 indexed taskId, uint256 indexed milestoneIndex, address worker, uint256 amount, uint256 deadline);
    event MilestoneReleased(bytes32 indexed taskId, uint256 indexed milestoneIndex, address worker, uint256 amount);
    event MilestoneDisputed(bytes32 indexed taskId, uint256 indexed milestoneIndex, address disputedBy);
    event MilestoneRefunded(bytes32 indexed taskId, uint256 indexed milestoneIndex, address requestor, uint256 amount);
    event DisputeResolved(bytes32 indexed taskId, uint256 indexed milestoneIndex, bool releasedToWorker, address resolvedBy);
    event TaskCancelled(bytes32 indexed taskId);
    event CoordinatorSet(bytes32 indexed taskId, address coordinator);

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

    // ═══════════════════════════════════════════
    // Phase 1: Task Creation + Bidding
    // ═══════════════════════════════════════════

    /**
     * @notice Create a task in bidding state.
     * @param taskId        Unique task ID
     * @param totalBudget   Maximum budget (informational, actual amounts set per milestone)
     * @param milestoneCount Number of milestones
     * @param bidDeadline   Unix timestamp after which no more bids accepted
     * @param bondAmount    USDC bond each bidder must deposit (0 = no bond)
     */
    function createTask(
        bytes32 taskId,
        uint256 totalBudget,
        uint256 milestoneCount,
        uint256 bidDeadline,
        uint256 bondAmount
    ) external {
        require(!tasks[taskId].exists, "task exists");
        require(milestoneCount > 0 && milestoneCount <= MAX_MILESTONES, "invalid milestone count");
        require(bidDeadline > block.timestamp, "deadline passed");

        tasks[taskId] = Task({
            requestor: msg.sender,
            totalBudget: totalBudget,
            milestoneCount: milestoneCount,
            releasedCount: 0,
            bidDeadline: bidDeadline,
            bondAmount: bondAmount,
            status: TaskStatus.Bidding,
            coordinator: address(0),
            exists: true
        });

        // Initialize milestones as unassigned
        for (uint256 i = 0; i < milestoneCount; i++) {
            milestones[taskId][i] = Milestone({
                worker: address(0),
                amount: 0,
                deadline: 0,
                status: MilestoneStatus.Unassigned,
                disputeTimestamp: 0
            });
        }

        emit TaskCreated(taskId, msg.sender, totalBudget, milestoneCount, bidDeadline);
    }

    /**
     * @notice Worker places a bid with optional bond deposit.
     */
    function placeBid(bytes32 taskId, uint256 price) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status == TaskStatus.Bidding, "not bidding");
        require(block.timestamp <= t.bidDeadline, "bid deadline passed");
        require(msg.sender != t.requestor, "requestor cannot bid");
        require(bidIndex[taskId][msg.sender] == 0, "already bid");
        require(bids[taskId].length < MAX_BIDS, "max bids reached");

        // Deposit bond if required
        if (t.bondAmount > 0) {
            _safeTransferFrom(msg.sender, address(this), t.bondAmount);
        }

        bids[taskId].push(Bid({
            worker: msg.sender,
            price: price,
            bonded: t.bondAmount > 0,
            accepted: false,
            refunded: false
        }));

        bidIndex[taskId][msg.sender] = bids[taskId].length; // 1-indexed
        emit BidPlaced(taskId, msg.sender, price, t.bondAmount);
    }

    /**
     * @notice Requestor accepts a bid. Can accept multiple workers.
     */
    function acceptBid(bytes32 taskId, address worker) external {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status == TaskStatus.Bidding, "not bidding");
        require(msg.sender == t.requestor, "not requestor");

        uint256 idx = bidIndex[taskId][worker];
        require(idx > 0, "no bid from worker");

        Bid storage b = bids[taskId][idx - 1];
        require(!b.accepted, "already accepted");
        b.accepted = true;

        emit BidAccepted(taskId, worker);
    }

    /**
     * @notice Refund bond to non-selected bidder. Can be called by anyone after task is Active/Completed/Cancelled.
     */
    function refundBond(bytes32 taskId, address worker) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status != TaskStatus.Bidding, "still bidding");

        uint256 idx = bidIndex[taskId][worker];
        require(idx > 0, "no bid");

        Bid storage b = bids[taskId][idx - 1];
        require(!b.accepted, "bid was accepted");
        require(b.bonded, "no bond");
        require(!b.refunded, "already refunded");

        b.refunded = true;
        _safeTransfer(worker, t.bondAmount);
        emit BidBondRefunded(taskId, worker, t.bondAmount);
    }

    // ═══════════════════════════════════════════
    // Phase 2: Assignment + Funding
    // ═══════════════════════════════════════════

    /**
     * @notice Assign milestones to accepted workers and fund the task.
     *         Transitions task from Bidding to Active.
     * @param taskId     Task ID
     * @param workers    Worker address per milestone
     * @param amounts    USDC amount per milestone
     * @param deadlines  Deadline per milestone
     */
    function fundAndAssign(
        bytes32 taskId,
        address[] calldata workers,
        uint256[] calldata amounts,
        uint256[] calldata deadlines
    ) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status == TaskStatus.Bidding, "not bidding");
        require(msg.sender == t.requestor, "not requestor");
        require(workers.length == t.milestoneCount, "wrong worker count");
        require(amounts.length == t.milestoneCount, "wrong amount count");
        require(deadlines.length == t.milestoneCount, "wrong deadline count");

        uint256 total = 0;
        for (uint256 i = 0; i < t.milestoneCount; i++) {
            require(workers[i] != address(0), "zero worker");
            require(workers[i] != t.requestor, "worker is requestor");
            require(amounts[i] > 0, "zero amount");
            require(deadlines[i] > block.timestamp, "deadline passed");

            // Worker must have an accepted bid
            uint256 bidIdx = bidIndex[taskId][workers[i]];
            require(bidIdx > 0, "worker has no bid");
            require(bids[taskId][bidIdx - 1].accepted, "bid not accepted");

            milestones[taskId][i] = Milestone({
                worker: workers[i],
                amount: amounts[i],
                deadline: deadlines[i],
                status: MilestoneStatus.Active,
                disputeTimestamp: 0
            });

            total += amounts[i];
            emit MilestoneAssigned(taskId, i, workers[i], amounts[i], deadlines[i]);
        }

        t.totalBudget = total;
        t.status = TaskStatus.Active;

        _safeTransferFrom(msg.sender, address(this), total);
        emit TaskFunded(taskId, total);
    }

    /**
     * @notice Set a coordinator for the task (can delegate subtasks).
     */
    function setCoordinator(bytes32 taskId, address coordinator) external {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(msg.sender == t.requestor, "not requestor");
        require(t.status == TaskStatus.Active, "not active");

        // Coordinator must be an accepted bidder
        uint256 bidIdx = bidIndex[taskId][coordinator];
        require(bidIdx > 0, "not a bidder");
        require(bids[taskId][bidIdx - 1].accepted, "bid not accepted");

        t.coordinator = coordinator;
        emit CoordinatorSet(taskId, coordinator);
    }

    // ═══════════════════════════════════════════
    // Phase 3: Work + Release
    // ═══════════════════════════════════════════

    /**
     * @notice Release a milestone to its assigned worker.
     */
    function releaseMilestone(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status == TaskStatus.Active, "not active");
        require(msg.sender == t.requestor, "not requestor");
        require(milestoneIndex < t.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");

        m.status = MilestoneStatus.Released;
        t.releasedCount++;

        if (t.releasedCount == t.milestoneCount) {
            t.status = TaskStatus.Completed;
        }

        _safeTransfer(m.worker, m.amount);
        emit MilestoneReleased(taskId, milestoneIndex, m.worker, m.amount);
    }

    /**
     * @notice Dispute a milestone.
     */
    function disputeMilestone(bytes32 taskId, uint256 milestoneIndex) external {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(t.status == TaskStatus.Active, "not active");
        require(milestoneIndex < t.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Active, "not active");
        require(msg.sender == t.requestor || msg.sender == m.worker, "not party");

        m.status = MilestoneStatus.Disputed;
        m.disputeTimestamp = block.timestamp;
        emit MilestoneDisputed(taskId, milestoneIndex, msg.sender);
    }

    /**
     * @notice Arbitrator resolves a milestone dispute.
     */
    function resolveDisputeMilestone(bytes32 taskId, uint256 milestoneIndex, bool releaseToWorker) external nonReentrant {
        require(msg.sender == arbitrator, "not arbitrator");
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(milestoneIndex < t.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "not disputed");

        if (releaseToWorker) {
            m.status = MilestoneStatus.Released;
            t.releasedCount++;
            _safeTransfer(m.worker, m.amount);
            emit MilestoneReleased(taskId, milestoneIndex, m.worker, m.amount);
        } else {
            m.status = MilestoneStatus.Refunded;
            _safeTransfer(t.requestor, m.amount);
            emit MilestoneRefunded(taskId, milestoneIndex, t.requestor, m.amount);
        }
        emit DisputeResolved(taskId, milestoneIndex, releaseToWorker, msg.sender);
    }

    /**
     * @notice Requestor claims refund on disputed milestone after timeout.
     */
    function claimMilestoneTimeout(bytes32 taskId, uint256 milestoneIndex) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(msg.sender == t.requestor, "not requestor");
        require(milestoneIndex < t.milestoneCount, "invalid index");

        Milestone storage m = milestones[taskId][milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "not disputed");
        require(block.timestamp >= m.disputeTimestamp + disputeTimeout, "timeout not reached");

        m.status = MilestoneStatus.Refunded;
        _safeTransfer(t.requestor, m.amount);
        emit MilestoneRefunded(taskId, milestoneIndex, t.requestor, m.amount);
    }

    /**
     * @notice Cancel a task during bidding. Refunds all bonds.
     */
    function cancelTask(bytes32 taskId) external nonReentrant {
        Task storage t = tasks[taskId];
        require(t.exists, "no task");
        require(msg.sender == t.requestor, "not requestor");
        require(t.status == TaskStatus.Bidding, "cannot cancel active task");

        t.status = TaskStatus.Cancelled;

        // Auto-refund all bonds
        for (uint256 i = 0; i < bids[taskId].length; i++) {
            Bid storage b = bids[taskId][i];
            if (b.bonded && !b.refunded) {
                b.refunded = true;
                _safeTransfer(b.worker, t.bondAmount);
                emit BidBondRefunded(taskId, b.worker, t.bondAmount);
            }
        }

        emit TaskCancelled(taskId);
    }

    // ═══════════════════════════════════════════
    // Views
    // ═══════════════════════════════════════════

    function getTask(bytes32 taskId) external view returns (
        address requestor, uint256 totalBudget, uint256 milestoneCount,
        uint256 releasedCount, uint256 bidDeadline, uint256 bondAmount,
        uint8 status_, address coordinator, bool exists_
    ) {
        Task storage t = tasks[taskId];
        return (t.requestor, t.totalBudget, t.milestoneCount, t.releasedCount,
                t.bidDeadline, t.bondAmount, uint8(t.status), t.coordinator, t.exists);
    }

    function getMilestone(bytes32 taskId, uint256 index) external view returns (
        address worker, uint256 amount, uint256 deadline, uint8 status_, uint256 disputeTimestamp
    ) {
        Milestone storage m = milestones[taskId][index];
        return (m.worker, m.amount, m.deadline, uint8(m.status), m.disputeTimestamp);
    }

    function getBidCount(bytes32 taskId) external view returns (uint256) {
        return bids[taskId].length;
    }

    function getBid(bytes32 taskId, uint256 index) external view returns (
        address worker, uint256 price, bool bonded, bool accepted, bool refunded
    ) {
        Bid storage b = bids[taskId][index];
        return (b.worker, b.price, b.bonded, b.accepted, b.refunded);
    }

    // ─── Admin ───

    function setArbitrator(address _arbitrator) external onlyOwner {
        require(_arbitrator != address(0), "zero arbitrator");
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
