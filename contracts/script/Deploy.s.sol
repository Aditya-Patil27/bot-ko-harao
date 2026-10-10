// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/BotKoHarao.sol";

// Reads the same variable names as server/.env. The operator key deploys, so it
// becomes the contract's operator. Chhota is bots[0], Bada is bots[1].
contract Deploy is Script {
    function run() external returns (BotKoHarao game) {
        uint256 operatorPk = vm.envUint("OPERATOR_PK");
        address chhota = vm.addr(vm.envUint("BOT_CHHOTA_PK"));
        address bada = vm.addr(vm.envUint("BOT_BADA_PK"));
        uint256 r = vm.envOr("PAY_R_WEI", uint256(0.02 ether));
        uint256 g = vm.envOr("PAY_G_WEI", uint256(0.05 ether));
        // Optional: bankroll each bot in the same run.
        uint256 bankroll = vm.envOr("BOT_BANKROLL_WEI", uint256(0));

        vm.startBroadcast(operatorPk);
        game = new BotKoHarao(chhota, bada, r, g);
        if (bankroll > 0) {
            game.fund{value: bankroll}(chhota);
            game.fund{value: bankroll}(bada);
        }
        vm.stopBroadcast();

        console.log("BotKoHarao:", address(game));
        console.log("operator:  ", vm.addr(operatorPk));
        console.log("chhota:    ", chhota);
        console.log("bada:      ", bada);
    }
}
