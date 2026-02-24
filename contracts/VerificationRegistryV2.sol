// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title VerificationRegistryV2
 * @notice On-chain verification trail for agent swarm deliverables.
 *         V2 fixes from security audit:
 *         - Access control on recordVerification (only worker, requestor, or authorized verifier)
 *         - Owner-managed verifier whitelist
 *         - Prevents unauthorized agents from marking deliverables as passed
 *
 * Companion to TaskEscrowV2 — stores deliverable hashes, not content.
 *
 * Flow:
 *   1. Requestor creates escrow (TaskEscrowV2) + sets acceptance criteria hash
 *   2. Worker submits deliverable hash after completing work
 *   3. Verification result recorded by authorized party only
 *   4. Requestor reviews and releases escrow
 */
contract VerificationRegistryV2 {

    struct Deliverable {
        bytes32 deliverableHash;    // SHA-256 of the work product
        bytes32 criteriaHash;       // SHA-256 of acceptance criteria
        bytes32 verificationHash;   // SHA-256 of verification result
        address worker;             // who submitted
        address requestor;          // who set criteria
        address verifier;           // who verified
        uint256 submittedAt;
        uint256 verifiedAt;
        bool verified;
        bool passed;
    }

    address public owner;
    mapping(bytes32 => Deliverable) public deliverables;
    mapping(address => bool) public authorizedVerifiers;

    // Track submissions per worker for reputation
    mapping(address => uint256) public totalSubmissions;
    mapping(address => uint256) public totalVerified;
    mapping(address => uint256) public totalPassed;

    event CriteriaSet(bytes32 indexed taskId, bytes32 criteriaHash, address indexed requestor);
    event DeliverableSubmitted(bytes32 indexed taskId, bytes32 deliverableHash, address indexed worker);
    event VerificationRecorded(bytes32 indexed taskId, bytes32 verificationHash, bool passed, address indexed verifier);
    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── Admin ───

    function addVerifier(address verifier) external onlyOwner {
        require(verifier != address(0), "zero address");
        authorizedVerifiers[verifier] = true;
        emit VerifierAdded(verifier);
    }

    function removeVerifier(address verifier) external onlyOwner {
        authorizedVerifiers[verifier] = false;
        emit VerifierRemoved(verifier);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Write Operations ───

    /**
     * @notice Requestor sets acceptance criteria for a task.
     *         Records the requestor address for access control.
     */
    function setCriteria(bytes32 taskId, bytes32 criteriaHash) external {
        require(deliverables[taskId].deliverableHash == bytes32(0), "deliverable already submitted");
        deliverables[taskId].criteriaHash = criteriaHash;
        deliverables[taskId].requestor = msg.sender;
        emit CriteriaSet(taskId, criteriaHash, msg.sender);
    }

    /**
     * @notice Worker submits deliverable hash after completing work.
     */
    function submitDeliverable(bytes32 taskId, bytes32 deliverableHash) external {
        require(deliverableHash != bytes32(0), "empty hash");
        require(deliverables[taskId].deliverableHash == bytes32(0), "already submitted");

        deliverables[taskId].deliverableHash = deliverableHash;
        deliverables[taskId].worker = msg.sender;
        deliverables[taskId].submittedAt = block.timestamp;

        totalSubmissions[msg.sender]++;
        emit DeliverableSubmitted(taskId, deliverableHash, msg.sender);
    }

    /**
     * @notice Record verification result. ACCESS CONTROLLED:
     *         Only the worker (self-verification), the requestor, or
     *         an authorized third-party verifier can call this.
     *
     * @param taskId           Task ID hash
     * @param verificationHash SHA-256 of the verification report
     * @param passed           Whether the deliverable met criteria
     */
    function recordVerification(
        bytes32 taskId,
        bytes32 verificationHash,
        bool passed
    ) external {
        Deliverable storage d = deliverables[taskId];
        require(d.deliverableHash != bytes32(0), "no deliverable");
        require(!d.verified, "already verified");

        // SECURITY: Only authorized parties can verify
        require(
            msg.sender == d.worker ||
            msg.sender == d.requestor ||
            authorizedVerifiers[msg.sender],
            "not authorized to verify"
        );

        d.verificationHash = verificationHash;
        d.verifier = msg.sender;
        d.verifiedAt = block.timestamp;
        d.verified = true;
        d.passed = passed;

        totalVerified[d.worker]++;
        if (passed) totalPassed[d.worker]++;

        emit VerificationRecorded(taskId, verificationHash, passed, msg.sender);
    }

    // ─── Views ───

    function getDeliverable(bytes32 taskId) external view returns (
        bytes32 deliverableHash,
        bytes32 criteriaHash,
        bytes32 verificationHash,
        address worker,
        address verifier,
        uint256 submittedAt,
        uint256 verifiedAt,
        bool verified,
        bool passed
    ) {
        Deliverable storage d = deliverables[taskId];
        return (
            d.deliverableHash, d.criteriaHash, d.verificationHash,
            d.worker, d.verifier,
            d.submittedAt, d.verifiedAt,
            d.verified, d.passed
        );
    }

    function getWorkerStats(address worker) external view returns (
        uint256 submissions,
        uint256 verifiedCount,
        uint256 passedCount
    ) {
        return (totalSubmissions[worker], totalVerified[worker], totalPassed[worker]);
    }

    function isAuthorizedVerifier(address verifier) external view returns (bool) {
        return authorizedVerifiers[verifier];
    }
}
