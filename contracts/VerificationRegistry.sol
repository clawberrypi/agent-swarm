// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title VerificationRegistry
 * @notice On-chain verification trail for agent swarm deliverables.
 *         Companion to TaskEscrowV2 — stores deliverable hashes,
 *         acceptance criteria, and verification results.
 *
 * Flow:
 *   1. Requestor creates escrow (TaskEscrowV2) + optionally sets acceptance criteria hash
 *   2. Worker submits deliverable hash after completing work
 *   3. Verification result (automated or AI) is recorded
 *   4. Requestor reviews and releases escrow (on TaskEscrowV2)
 *
 * All actual content lives on XMTP. Only hashes go on-chain.
 */
contract VerificationRegistry {

    struct Deliverable {
        bytes32 deliverableHash;    // SHA-256 of the work product
        bytes32 criteriaHash;       // SHA-256 of acceptance criteria (tests, spec)
        bytes32 verificationHash;   // SHA-256 of verification result
        address worker;             // who submitted
        address verifier;           // who verified (address(0) = automated)
        uint256 submittedAt;
        uint256 verifiedAt;
        bool verified;              // verification was performed
        bool passed;                // verification passed
    }

    mapping(bytes32 => Deliverable) public deliverables;

    // Track submissions per worker for reputation
    mapping(address => uint256) public totalSubmissions;
    mapping(address => uint256) public totalVerified;
    mapping(address => uint256) public totalPassed;

    event CriteriaSet(bytes32 indexed taskId, bytes32 criteriaHash, address indexed requestor);
    event DeliverableSubmitted(bytes32 indexed taskId, bytes32 deliverableHash, address indexed worker);
    event VerificationRecorded(bytes32 indexed taskId, bytes32 verificationHash, bool passed, address indexed verifier);

    /**
     * @notice Requestor sets acceptance criteria for a task.
     *         Call after creating escrow. Criteria hash = SHA-256 of test file or spec.
     */
    function setCriteria(bytes32 taskId, bytes32 criteriaHash) external {
        require(deliverables[taskId].deliverableHash == bytes32(0), "deliverable already submitted");
        deliverables[taskId].criteriaHash = criteriaHash;
        emit CriteriaSet(taskId, criteriaHash, msg.sender);
    }

    /**
     * @notice Worker submits deliverable hash after completing work.
     *         The actual deliverable lives on XMTP — only the hash goes on-chain.
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
     * @notice Record verification result. Can be called by:
     *         - The worker (automated self-verification, e.g. test results)
     *         - The requestor (manual review)
     *         - A third-party verifier agent
     *
     * @param taskId           Task ID hash (same as escrow)
     * @param verificationHash SHA-256 of the full verification report
     * @param passed           Whether the deliverable met acceptance criteria
     */
    function recordVerification(
        bytes32 taskId,
        bytes32 verificationHash,
        bool passed
    ) external {
        require(deliverables[taskId].deliverableHash != bytes32(0), "no deliverable");
        require(!deliverables[taskId].verified, "already verified");

        deliverables[taskId].verificationHash = verificationHash;
        deliverables[taskId].verifier = msg.sender;
        deliverables[taskId].verifiedAt = block.timestamp;
        deliverables[taskId].verified = true;
        deliverables[taskId].passed = passed;

        address worker = deliverables[taskId].worker;
        totalVerified[worker]++;
        if (passed) totalPassed[worker]++;

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
}
