// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

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
        emit EscrowDisputed(taskId, msg.sender);
    }

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
}
