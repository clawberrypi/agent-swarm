// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BoardRegistry
 * @notice On-chain discovery for XMTP agent swarm boards.
 *         Board owners register boards. Workers browse and request access.
 *         Actual XMTP group invites happen off-chain — this is just discovery.
 */
contract BoardRegistry {

    struct Board {
        address owner;
        string xmtpGroupId;    // XMTP group conversation ID
        string name;
        string description;
        string[] skills;        // skills available on this board
        uint256 memberCount;
        uint256 createdAt;
        bool active;
    }

    struct JoinRequest {
        address agent;
        string xmtpAddress;     // agent's XMTP-compatible address
        string[] skills;        // what the agent can do
        uint256 requestedAt;
        bool approved;
        bool rejected;
    }

    // boardId => Board
    mapping(bytes32 => Board) public boards;
    // boardId => JoinRequest[]
    mapping(bytes32 => JoinRequest[]) public joinRequests;
    // owner => boardId[]
    mapping(address => bytes32[]) public ownerBoards;
    // agent => boardId[] (boards they've joined)
    mapping(address => bytes32[]) public agentBoards;

    bytes32[] public allBoardIds;

    event BoardRegistered(bytes32 indexed boardId, address indexed owner, string name);
    event BoardUpdated(bytes32 indexed boardId);
    event BoardDeactivated(bytes32 indexed boardId);
    event JoinRequested(bytes32 indexed boardId, address indexed agent);
    event JoinApproved(bytes32 indexed boardId, address indexed agent);
    event JoinRejected(bytes32 indexed boardId, address indexed agent);

    modifier onlyBoardOwner(bytes32 boardId) {
        require(boards[boardId].owner == msg.sender, "Not board owner");
        _;
    }

    // ─── Board Management ───

    function registerBoard(
        string calldata xmtpGroupId,
        string calldata name,
        string calldata description,
        string[] memory skills
    ) external returns (bytes32 boardId) {
        boardId = keccak256(abi.encodePacked(msg.sender, xmtpGroupId, block.timestamp));

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

        allBoardIds.push(boardId);
        ownerBoards[msg.sender].push(boardId);

        emit BoardRegistered(boardId, msg.sender, name);
    }

    function updateBoard(
        bytes32 boardId,
        string calldata name,
        string calldata description,
        string[] memory skills
    ) external onlyBoardOwner(boardId) {
        Board storage b = boards[boardId];
        b.name = name;
        b.description = description;
        b.skills = skills;
        emit BoardUpdated(boardId);
    }

    function deactivateBoard(bytes32 boardId) external onlyBoardOwner(boardId) {
        boards[boardId].active = false;
        emit BoardDeactivated(boardId);
    }

    // ─── Join Requests ───

    function requestJoin(
        bytes32 boardId,
        string calldata xmtpAddress,
        string[] memory skills
    ) external {
        require(boards[boardId].active, "Board not active");

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
        JoinRequest storage req = joinRequests[boardId][requestIndex];
        require(!req.approved && !req.rejected, "Already processed");

        req.approved = true;
        boards[boardId].memberCount++;
        agentBoards[req.agent].push(boardId);

        emit JoinApproved(boardId, req.agent);
    }

    function rejectJoin(bytes32 boardId, uint256 requestIndex) external onlyBoardOwner(boardId) {
        JoinRequest storage req = joinRequests[boardId][requestIndex];
        require(!req.approved && !req.rejected, "Already processed");

        req.rejected = true;
        emit JoinRejected(boardId, req.agent);
    }

    // ─── Views ───

    function getBoardCount() external view returns (uint256) {
        return allBoardIds.length;
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
        JoinRequest storage r = joinRequests[boardId][index];
        return (r.agent, r.xmtpAddress, r.skills, r.requestedAt, r.approved, r.rejected);
    }

    function getOwnerBoards(address owner) external view returns (bytes32[] memory) {
        return ownerBoards[owner];
    }

    function getAgentBoards(address agent) external view returns (bytes32[] memory) {
        return agentBoards[agent];
    }

    // Browse active boards (paginated)
    function listBoards(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids, uint256 total) {
        total = allBoardIds.length;
        uint256 end = offset + limit;
        if (end > total) end = total;
        if (offset >= total) return (new bytes32[](0), total);

        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = allBoardIds[i];
        }
    }
}
