// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BoardRegistryV2
 * @notice On-chain discovery for XMTP agent swarm boards.
 *         Fixes from V1 audit: duplicate protection, spam limits, ownership transfer,
 *         board removal from listing, bounded join requests.
 */
contract BoardRegistryV2 {

    struct Board {
        address owner;
        string xmtpGroupId;
        string name;
        string description;
        string[] skills;
        uint256 memberCount;
        uint256 createdAt;
        bool active;
    }

    struct JoinRequest {
        address agent;
        string xmtpAddress;
        string[] skills;
        uint256 requestedAt;
        bool approved;
        bool rejected;
    }

    // ─── State ───

    mapping(bytes32 => Board) public boards;
    mapping(bytes32 => JoinRequest[]) public joinRequests;
    mapping(address => bytes32[]) public ownerBoards;
    mapping(address => bytes32[]) public agentBoards;

    // Spam prevention: agent => boardId => has pending request
    mapping(address => mapping(bytes32 => bool)) public hasPendingRequest;
    // Track registered xmtpGroupIds to prevent duplicates
    mapping(bytes32 => bool) public xmtpGroupRegistered;

    bytes32[] public activeBoardIds;
    // boardId => index in activeBoardIds (for O(1) removal)
    mapping(bytes32 => uint256) private activeBoardIndex;

    uint256 public constant MAX_JOIN_REQUESTS_PER_BOARD = 1000;
    uint256 public constant MAX_SKILLS = 20;
    uint256 public constant MAX_NAME_LENGTH = 100;
    uint256 public constant MAX_DESCRIPTION_LENGTH = 500;

    // ─── Events ───

    event BoardRegistered(bytes32 indexed boardId, address indexed owner, string name);
    event BoardUpdated(bytes32 indexed boardId);
    event BoardDeactivated(bytes32 indexed boardId);
    event OwnershipTransferred(bytes32 indexed boardId, address indexed oldOwner, address indexed newOwner);
    event JoinRequested(bytes32 indexed boardId, address indexed agent);
    event JoinApproved(bytes32 indexed boardId, address indexed agent);
    event JoinRejected(bytes32 indexed boardId, address indexed agent);

    // ─── Modifiers ───

    modifier onlyBoardOwner(bytes32 boardId) {
        require(boards[boardId].owner == msg.sender, "Not board owner");
        _;
    }

    modifier boardExists(bytes32 boardId) {
        require(boards[boardId].owner != address(0), "Board does not exist");
        _;
    }

    modifier boardActive(bytes32 boardId) {
        require(boards[boardId].active, "Board not active");
        _;
    }

    // ─── Board Management ───

    function registerBoard(
        string calldata xmtpGroupId,
        string calldata name,
        string calldata description,
        string[] memory skills
    ) external returns (bytes32 boardId) {
        require(bytes(xmtpGroupId).length > 0, "Empty group ID");
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME_LENGTH, "Invalid name length");
        require(bytes(description).length <= MAX_DESCRIPTION_LENGTH, "Description too long");
        require(skills.length <= MAX_SKILLS, "Too many skills");

        // Prevent duplicate registration of same XMTP group
        bytes32 groupHash = keccak256(bytes(xmtpGroupId));
        require(!xmtpGroupRegistered[groupHash], "Group already registered");
        xmtpGroupRegistered[groupHash] = true;

        // Use nonce-like approach to avoid same-block collisions
        boardId = keccak256(abi.encodePacked(msg.sender, xmtpGroupId, block.timestamp, activeBoardIds.length));

        boards[boardId] = Board({
            owner: msg.sender,
            xmtpGroupId: xmtpGroupId,
            name: name,
            description: description,
            skills: skills,
            memberCount: 1,
            createdAt: block.timestamp,
            active: true
        });

        activeBoardIndex[boardId] = activeBoardIds.length;
        activeBoardIds.push(boardId);
        ownerBoards[msg.sender].push(boardId);

        emit BoardRegistered(boardId, msg.sender, name);
    }

    function updateBoard(
        bytes32 boardId,
        string calldata name,
        string calldata description,
        string[] memory skills
    ) external onlyBoardOwner(boardId) boardExists(boardId) {
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME_LENGTH, "Invalid name length");
        require(bytes(description).length <= MAX_DESCRIPTION_LENGTH, "Description too long");
        require(skills.length <= MAX_SKILLS, "Too many skills");

        Board storage b = boards[boardId];
        b.name = name;
        b.description = description;
        b.skills = skills;
        emit BoardUpdated(boardId);
    }

    function deactivateBoard(bytes32 boardId) external onlyBoardOwner(boardId) boardActive(boardId) {
        boards[boardId].active = false;

        // Remove from active list (swap-and-pop)
        uint256 idx = activeBoardIndex[boardId];
        uint256 lastIdx = activeBoardIds.length - 1;
        if (idx != lastIdx) {
            bytes32 lastId = activeBoardIds[lastIdx];
            activeBoardIds[idx] = lastId;
            activeBoardIndex[lastId] = idx;
        }
        activeBoardIds.pop();
        delete activeBoardIndex[boardId];

        // Free the xmtpGroupId for re-registration
        bytes32 groupHash = keccak256(bytes(boards[boardId].xmtpGroupId));
        xmtpGroupRegistered[groupHash] = false;

        emit BoardDeactivated(boardId);
    }

    function transferOwnership(bytes32 boardId, address newOwner) external onlyBoardOwner(boardId) boardExists(boardId) {
        require(newOwner != address(0), "Zero address");
        address oldOwner = boards[boardId].owner;
        boards[boardId].owner = newOwner;
        ownerBoards[newOwner].push(boardId);
        emit OwnershipTransferred(boardId, oldOwner, newOwner);
    }

    // ─── Join Requests ───

    function requestJoin(
        bytes32 boardId,
        string calldata xmtpAddress,
        string[] memory skills
    ) external boardActive(boardId) {
        require(!hasPendingRequest[msg.sender][boardId], "Already has pending request");
        require(joinRequests[boardId].length < MAX_JOIN_REQUESTS_PER_BOARD, "Too many requests");
        require(skills.length <= MAX_SKILLS, "Too many skills");
        require(bytes(xmtpAddress).length > 0, "Empty XMTP address");

        hasPendingRequest[msg.sender][boardId] = true;

        joinRequests[boardId].push(JoinRequest({
            agent: msg.sender,
            xmtpAddress: xmtpAddress,
            skills: skills,
            requestedAt: block.timestamp,
            approved: false,
            rejected: false
        }));

        emit JoinRequested(boardId, msg.sender);
    }

    function approveJoin(bytes32 boardId, uint256 requestIndex) external onlyBoardOwner(boardId) {
        require(requestIndex < joinRequests[boardId].length, "Invalid index");
        JoinRequest storage req = joinRequests[boardId][requestIndex];
        require(!req.approved && !req.rejected, "Already processed");

        req.approved = true;
        boards[boardId].memberCount++;
        agentBoards[req.agent].push(boardId);
        hasPendingRequest[req.agent][boardId] = false;

        emit JoinApproved(boardId, req.agent);
    }

    function rejectJoin(bytes32 boardId, uint256 requestIndex) external onlyBoardOwner(boardId) {
        require(requestIndex < joinRequests[boardId].length, "Invalid index");
        JoinRequest storage req = joinRequests[boardId][requestIndex];
        require(!req.approved && !req.rejected, "Already processed");

        req.rejected = true;
        hasPendingRequest[req.agent][boardId] = false;

        emit JoinRejected(boardId, req.agent);
    }

    // ─── Views ───

    function getActiveBoardCount() external view returns (uint256) {
        return activeBoardIds.length;
    }

    function getBoard(bytes32 boardId) external view returns (
        address owner, string memory xmtpGroupId, string memory name,
        string memory description, string[] memory skills,
        uint256 memberCount, uint256 createdAt, bool active
    ) {
        Board storage b = boards[boardId];
        return (b.owner, b.xmtpGroupId, b.name, b.description, b.skills, b.memberCount, b.createdAt, b.active);
    }

    function getBoardSkills(bytes32 boardId) external view returns (string[] memory) {
        return boards[boardId].skills;
    }

    function getJoinRequestCount(bytes32 boardId) external view returns (uint256) {
        return joinRequests[boardId].length;
    }

    function getJoinRequest(bytes32 boardId, uint256 index) external view returns (
        address agent, string memory xmtpAddress, string[] memory skills,
        uint256 requestedAt, bool approved, bool rejected
    ) {
        require(index < joinRequests[boardId].length, "Invalid index");
        JoinRequest storage r = joinRequests[boardId][index];
        return (r.agent, r.xmtpAddress, r.skills, r.requestedAt, r.approved, r.rejected);
    }

    function getOwnerBoards(address owner) external view returns (bytes32[] memory) {
        return ownerBoards[owner];
    }

    function getAgentBoards(address agent) external view returns (bytes32[] memory) {
        return agentBoards[agent];
    }

    // Only returns active boards
    function listBoards(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids, uint256 total) {
        total = activeBoardIds.length;
        uint256 end = offset + limit;
        if (end > total) end = total;
        if (offset >= total) return (new bytes32[](0), total);

        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = activeBoardIds[i];
        }
    }
}
