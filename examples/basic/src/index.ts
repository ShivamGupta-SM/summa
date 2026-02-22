import { createSumma } from "@summa-ledger/summa";
import { memoryAdapter } from "@summa-ledger/memory-adapter";

async function main() {
	// Create a Summa instance with the in-memory adapter
	const summa = createSumma({
		adapter: memoryAdapter(),
		currency: "USD",
	});

	// Create two accounts
	console.log("Creating accounts...");
	const alice = await summa.accounts.create({
		holderId: "alice",
		holderType: "customer",
		currency: "USD",
	});
	console.log(`  Alice: ${alice.id} (balance: ${alice.balance})`);

	const bob = await summa.accounts.create({
		holderId: "bob",
		holderType: "customer",
		currency: "USD",
	});
	console.log(`  Bob:   ${bob.id} (balance: ${bob.balance})`);

	// Fund Alice's account via a system account
	console.log("\nFunding Alice's account with $100...");
	const funding = await summa.transactions.post({
		destinationHolderId: "alice",
		amount: 100_00, // $100.00 in cents
		currency: "USD",
		reference: "initial_funding",
		description: "Initial account funding",
	});
	console.log(`  Transaction: ${funding.id} (status: ${funding.status})`);

	// Check Alice's updated balance
	const aliceAfterFunding = await summa.accounts.get({ accountId: alice.id });
	console.log(`  Alice balance: $${(Number(aliceAfterFunding.balance) / 100).toFixed(2)}`);

	// Transfer $25 from Alice to Bob
	console.log("\nTransferring $25 from Alice to Bob...");
	const transfer = await summa.transactions.post({
		sourceHolderId: "alice",
		destinationHolderId: "bob",
		amount: 25_00, // $25.00
		currency: "USD",
		reference: "transfer_001",
		description: "Payment from Alice to Bob",
	});
	console.log(`  Transaction: ${transfer.id} (status: ${transfer.status})`);

	// Check final balances
	const aliceFinal = await summa.accounts.get({ accountId: alice.id });
	const bobFinal = await summa.accounts.get({ accountId: bob.id });
	console.log(`\nFinal balances:`);
	console.log(`  Alice: $${(Number(aliceFinal.balance) / 100).toFixed(2)}`);
	console.log(`  Bob:   $${(Number(bobFinal.balance) / 100).toFixed(2)}`);

	// Create a hold (reserve funds)
	console.log("\nCreating a $10 hold on Alice's account...");
	const hold = await summa.holds.create({
		sourceHolderId: "alice",
		destinationHolderId: "bob",
		amount: 10_00, // $10.00
		currency: "USD",
	});
	console.log(`  Hold: ${hold.id}`);

	const aliceWithHold = await summa.accounts.get({ accountId: alice.id });
	console.log(`  Alice balance: $${(Number(aliceWithHold.balance) / 100).toFixed(2)} (pending debit: $${(Number(aliceWithHold.pendingDebit) / 100).toFixed(2)})`);

	// Capture the hold
	console.log("\nCapturing the hold...");
	const captured = await summa.holds.capture({ holdId: hold.id });
	console.log(`  Captured transaction: ${captured.id}`);

	const aliceAfterCapture = await summa.accounts.get({ accountId: alice.id });
	const bobAfterCapture = await summa.accounts.get({ accountId: bob.id });
	console.log(`\nFinal balances after hold capture:`);
	console.log(`  Alice: $${(Number(aliceAfterCapture.balance) / 100).toFixed(2)}`);
	console.log(`  Bob:   $${(Number(bobAfterCapture.balance) / 100).toFixed(2)}`);

	console.log("\nDone!");
}

main().catch(console.error);
