"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";

type Props = {
  userId: string;
  initialBalance: number;
};

export function WalletManagement({ userId, initialBalance }: Props) {
  const [amount, setAmount] = useState<number>(0);
  const [currentBalance, setCurrentBalance] = useState<number>(initialBalance);
  const [loading, setLoading] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [transactionType, setTransactionType] = useState<"add" | "subtract" | null>(null);

  const handleUpdateWallet = async () => {
    if (amount <= 0) {
      toast.error("Please enter a positive amount.");
      return;
    }

    if (!transactionType) {
        toast.error("Invalid transaction type.");
        return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/users/${userId}/wallet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount, type: transactionType }),
      });

      const data = await response.json();

      if (response.ok) {
        toast.success(data.message);
        setCurrentBalance(data.newBalance); 
        setAmount(0);
      } else {
        toast.error(data.error || "An unexpected error occurred.");
      }
    } catch (error) {
      console.error("Failed to update wallet:", error);
      toast.error("An unexpected error occurred.");
    } finally {
      setLoading(false);
      setShowConfirmModal(false);
      setTransactionType(null);
    }
  };

  const openConfirmModal = (type: "add" | "subtract") => {
    if (amount <= 0) {
      toast.error("Please enter a positive amount.");
      return;
    }
    setTransactionType(type);
    setShowConfirmModal(true);
  };

  const closeConfirmModal = () => {
    setShowConfirmModal(false);
    setTransactionType(null);
  };

  return (
    <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3 mt-6">
      <h3 className="text-lg font-bold mb-4">Manage Wallet Dpcoins</h3>
      <div className="mb-4">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Current Balance: <span className="font-bold text-primary">{currentBalance} ⚡</span></p>
      </div>
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="amount" className="block text-sm font-medium text-gray-700 dark:text-gray-200">
            Amount
          </label>
          <input
            type="number"
            id="amount"
            value={amount}
            onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm dark:bg-dark-2 dark:border-dark-3 dark:text-white"
            placeholder="Enter amount"
            min="0"
          />
        </div>
        <div className="flex gap-4">
          <button
            onClick={() => openConfirmModal("add")}
            disabled={loading}
            className="flex-1 justify-center rounded-md border border-primary py-2 px-4 text-sm font-medium text-primary hover:bg-primary hover:text-white focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:hover:bg-primary dark:hover:text-white"
          >
            {loading && transactionType === "add" ? "Adding..." : "Add Dpcoins"}
          </button>
          <button
            onClick={() => openConfirmModal("subtract")}
            disabled={loading}
            className="flex-1 justify-center rounded-md border border-danger py-2 px-4 text-sm font-medium text-danger hover:bg-danger hover:text-white focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2 dark:hover:bg-danger dark:hover:text-white"
          >
            {loading && transactionType === "subtract" ? "Subtracting..." : "Subtract Dpcoins"}
          </button>
        </div>
      </div>

      {showConfirmModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-900 bg-opacity-50 flex justify-center items-center">
          <div className="relative w-full max-w-md cursor-pointer rounded-lg bg-white p-4 text-center shadow-md dark:bg-gray-dark">
            <h3 className="mb-2 text-lg font-bold">Confirm Transaction</h3>
            <p className="mb-4 text-sm text-gray-700 dark:text-gray-200">
              Are you sure you want to {transactionType} {amount} Dpcoins {transactionType === "add" ? "to" : "from"} the wallet?
            </p>
            <div className="flex justify-center gap-4">
              <button
                onClick={closeConfirmModal}
                className="rounded-md border border-gray-300 py-2 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:border-dark-3 dark:text-gray-200 dark:hover:bg-dark-2"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateWallet}
                disabled={loading}
                className={`rounded-md border py-2 px-4 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  transactionType === "add"
                    ? "border-primary bg-primary hover:bg-primary-dark focus:ring-primary"
                    : "border-danger bg-danger hover:bg-danger-dark focus:ring-danger"
                }`}
              >
                {loading ? "Processing..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}