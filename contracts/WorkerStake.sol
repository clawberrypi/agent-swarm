// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title WorkerStake
 * @notice Quality assurance through economic skin in the game.
 *         Workers stake USDC to bid on tasks. Stake is returned on successful
 *         completion + verification. Forfeited on ghost/fail.
 *
 * Philosophy: No reviews, no stars, no subjective ratings.
 *             Put money where your mouth is.
 *
 * Flow:
 *   1. Worker deposits USDC stake
 *   2. Worker bids on task (stake is locked for that task)
 *   3a. Task completed + verified → stake returned to worker
 *   3b. Task failed/ghosted → stake forfeited to requestor
 *   4. Emergency withdrawal after 30-day cooldown (no active locks)
 *
 * Security:
 *   - Reentrancy guard on all transfer paths
 *   - Safe ERC20 transfers with return value checks
 *   - Stake can only be slashed by the linked escrow contract
 *   - Emergency withdrawal requires cooldown period
 */
contract WorkerStake {

    struct StakeInfo {
        uint256 totalDeposited;
        uint256 available;       // not locked for any task
        uint256 locked;          // locked for active tasks
        uint256 slashed;         // total lost to slashing
        uint256 lastDepositTime;
        uint256 withdrawRequestTime; // 0 = no pending withdrawal
    }

    struct TaskLock {
        address worker;
        uint256 amount;
        bool resolved;
    }

    IERC20 public immutable usdc;
    address public owner;
    address public escrowContract; // TaskEscrowV2/V3 that can trigger slashing

    uint256 public constant EMERGENCY_COOLDOWN = 30 days;
    uint256 public constant MIN_STAKE = 100000; // 0.1 USDC (6 decimals)
    uint256 public constant MAX_STAKE = 10000000000; // 10,000 USDC

    mapping(address => StakeInfo) public stakes;
    mapping(bytes32 => TaskLock) public taskLocks; // taskId => lock

    // ─── Reentrancy Guard ───
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "reentrant");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyEscrow() {
        require(msg.sender == escrowContract, "not escrow");
        _;
    }

    // ─── Events ───

    event Deposited(address indexed worker, uint256 amount);
    event Withdrawn(address indexed worker, uint256 amount);
    event StakeLocked(bytes32 indexed taskId, address indexed worker, uint256 amount);
    event StakeUnlocked(bytes32 indexed taskId, address indexed worker, uint256 amount);
    event StakeSlashed(bytes32 indexed taskId, address indexed worker, address indexed requestor, uint256 amount);
    event EmergencyWithdrawRequested(address indexed worker, uint256 requestTime);
    event EmergencyWithdrawCancelled(address indexed worker);
    event EscrowContractUpdated(address oldEscrow, address newEscrow);

    constructor(address _usdc) {
        require(_usdc != address(0), "zero usdc");
        usdc = IERC20(_usdc);
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

    // ─── Staking ───

    /**
     * @notice Deposit USDC as stake. Worker must approve this contract first.
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount >= MIN_STAKE, "below minimum");
        StakeInfo storage s = stakes[msg.sender];
        require(s.totalDeposited + amount <= MAX_STAKE, "exceeds maximum");

        _safeTransferFrom(msg.sender, address(this), amount);

        s.totalDeposited += amount;
        s.available += amount;
        s.lastDepositTime = block.timestamp;
        s.withdrawRequestTime = 0; // cancel any pending withdrawal

        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw available (unlocked) stake.
     *         No cooldown for normal withdrawals — only emergency.
     */
    function withdraw(uint256 amount) external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        require(s.available >= amount, "insufficient available");

        s.available -= amount;
        s.totalDeposited -= amount;
        _safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Lock stake for a specific task (called when worker bids).
     *         Can be called by the worker themselves or by the escrow contract.
     */
    function lockForTask(bytes32 taskId, address worker, uint256 amount) external {
        require(msg.sender == worker || msg.sender == escrowContract, "not authorized");
        require(!taskLocks[taskId].resolved && taskLocks[taskId].amount == 0, "task already locked");

        StakeInfo storage s = stakes[worker];
        require(s.available >= amount, "insufficient stake");

        s.available -= amount;
        s.locked += amount;

        taskLocks[taskId] = TaskLock({
            worker: worker,
            amount: amount,
            resolved: false
        });

        emit StakeLocked(taskId, worker, amount);
    }

    /**
     * @notice Unlock stake after successful completion (return to worker).
     *         Called by escrow contract when escrow is released.
     */
    function unlockStake(bytes32 taskId) external onlyEscrow nonReentrant {
        TaskLock storage lock = taskLocks[taskId];
        require(!lock.resolved && lock.amount > 0, "no active lock");

        lock.resolved = true;
        StakeInfo storage s = stakes[lock.worker];
        s.locked -= lock.amount;
        s.available += lock.amount;

        emit StakeUnlocked(taskId, lock.worker, lock.amount);
    }

    /**
     * @notice Slash stake on failure/ghost (send to requestor).
     *         Called by escrow contract when escrow is disputed + resolved against worker,
     *         or when escrow is refunded.
     */
    function slashStake(bytes32 taskId, address requestor) external onlyEscrow nonReentrant {
        TaskLock storage lock = taskLocks[taskId];
        require(!lock.resolved && lock.amount > 0, "no active lock");

        lock.resolved = true;
        StakeInfo storage s = stakes[lock.worker];
        s.locked -= lock.amount;
        s.slashed += lock.amount;
        s.totalDeposited -= lock.amount;

        _safeTransfer(requestor, lock.amount);

        emit StakeSlashed(taskId, lock.worker, requestor, lock.amount);
    }

    // ─── Emergency Withdrawal ───

    /**
     * @notice Request emergency withdrawal (starts cooldown).
     *         After cooldown, worker can withdraw ALL funds including locked.
     *         This is a safety valve — should be rare.
     */
    function requestEmergencyWithdraw() external {
        StakeInfo storage s = stakes[msg.sender];
        require(s.totalDeposited > 0, "no stake");
        s.withdrawRequestTime = block.timestamp;
        emit EmergencyWithdrawRequested(msg.sender, block.timestamp);
    }

    function cancelEmergencyWithdraw() external {
        stakes[msg.sender].withdrawRequestTime = 0;
        emit EmergencyWithdrawCancelled(msg.sender);
    }

    /**
     * @notice Execute emergency withdrawal after cooldown.
     *         Returns ALL deposited funds (available + locked).
     */
    function executeEmergencyWithdraw() external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        require(s.withdrawRequestTime > 0, "no request");
        require(block.timestamp >= s.withdrawRequestTime + EMERGENCY_COOLDOWN, "cooldown not reached");

        uint256 amount = s.totalDeposited;
        require(amount > 0, "nothing to withdraw");

        s.totalDeposited = 0;
        s.available = 0;
        s.locked = 0;
        s.withdrawRequestTime = 0;

        _safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Views ───

    function getStake(address worker) external view returns (
        uint256 totalDeposited, uint256 available, uint256 locked,
        uint256 slashed, uint256 withdrawRequestTime
    ) {
        StakeInfo storage s = stakes[worker];
        return (s.totalDeposited, s.available, s.locked, s.slashed, s.withdrawRequestTime);
    }

    function getTaskLock(bytes32 taskId) external view returns (
        address worker, uint256 amount, bool resolved
    ) {
        TaskLock storage l = taskLocks[taskId];
        return (l.worker, l.amount, l.resolved);
    }

    // ─── Admin ───

    function setEscrowContract(address _escrow) external onlyOwner {
        emit EscrowContractUpdated(escrowContract, _escrow);
        escrowContract = _escrow;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
