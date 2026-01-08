"use client";

import { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { toast } from "react-hot-toast";
import InputGroup from "@/components/FormElements/InputGroup";
import UserSearch from "@/components/FormElements/UserSearch"; // Imported new component
import { callApi } from "@/services/firebase/functions";

const BroadcastPage = () => {
  const [activeTab, setActiveTab] = useState<"broadcast" | "individual">("broadcast");

  // Form States
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [targetAction, setTargetAction] = useState("/home");
  const [targetUserId, setTargetUserId] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !body) {
      toast.error("Title and Message are required!");
      return;
    }

    if (activeTab === "individual" && !targetUserId) {
        toast.error("Please search and select a user!");
        return;
    }

    const confirmMsg = activeTab === "broadcast" 
        ? "send this broadcast to ALL users?" 
        : `send this message to the selected user (ID: ${targetUserId})?`;

    const confirmSend = window.confirm(`Are you sure you want to ${confirmMsg}`);
    if (!confirmSend) return;

    setSending(true);
    try {
      let result: any;
      const payload = {
        title,
        body,
        imageUrl: imageUrl || null,
        data: {
            url: targetAction
        }
      };

      if (activeTab === "broadcast") {
          result = await callApi("sendBroadcastNotification", payload);
      } else {
          result = await callApi("sendIndividualNotification", {
              ...payload,
              userId: targetUserId
          });
      }

      if (result.success) {
        if (activeTab === "broadcast") {
            toast.success(`Successfully sent to ${result.sentCount} users!`);
        } else {
            toast.success("Notification sent to user!");
        }
        // Reset form
        setTitle("");
        setBody("");
        setImageUrl("");
        setTargetUserId("");
        setTargetAction("/home");
      } else {
        toast.error(result.message || "Something went wrong.");
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error.message || "Failed to send notification.");
    } finally {
      setSending(false);
    }
  };

  return (
    <DefaultLayout>
      <div className="mx-auto max-w-270">
        <Breadcrumb pageName="Push Notifications" />

        {/* Tabs */}
        <div className="mb-6 flex gap-4 border-b border-stroke dark:border-strokedark">
            <button
                className={`pb-4 text-sm font-medium ${
                    activeTab === "broadcast"
                        ? "border-b-2 border-primary text-primary"
                        : "text-gray-500 hover:text-primary"
                }`}
                onClick={() => setActiveTab("broadcast")}
            >
                Broadcast (All Users)
            </button>
            <button
                className={`pb-4 text-sm font-medium ${
                    activeTab === "individual"
                        ? "border-b-2 border-primary text-primary"
                        : "text-gray-500 hover:text-primary"
                }`}
                onClick={() => setActiveTab("individual")}
            >
                Individual User
            </button>
        </div>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {/* Form Section */}
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-7 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white">
                  {activeTab === "broadcast" ? "Create Broadcast Message" : "Send Individual Message"}
              </h3>
            </div>
            <div className="p-7">
              <form onSubmit={handleSend}>
                
                {activeTab === "individual" && (
                    <UserSearch 
                        label="Search User (Username)"
                        onSelect={(uid) => setTargetUserId(uid)}
                        selectedUserId={targetUserId}
                    />
                )}

                <div className="mb-6">
                  <InputGroup
                    label="Notification Title"
                    type="text"
                    placeholder="e.g. Special Bonus! 🎁"
                    value={title}
                    handleChange={(e) => setTitle(e.target.value)}
                  />
                </div>

                <div className="mb-6">
                  <label className="mb-3 block text-sm font-medium text-black dark:text-white">
                    Message Body
                  </label>
                  <textarea
                    rows={4}
                    placeholder="Type your message here..."
                    className="w-full rounded border border-stroke bg-gray px-4.5 py-3 text-black focus:border-primary focus-visible:outline-none dark:border-strokedark dark:bg-meta-4 dark:text-white dark:focus:border-primary"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  ></textarea>
                </div>

                <div className="mb-6">
                  <InputGroup
                    label="Image URL (Optional)"
                    type="text"
                    placeholder="https://example.com/image.png"
                    value={imageUrl}
                    handleChange={(e) => setImageUrl(e.target.value)}
                  />
                </div>

                <div className="mb-6">
                    <label className="mb-3 block text-sm font-medium text-black dark:text-white">
                        Target Action (On Click)
                    </label>
                    <div className="relative z-20 bg-transparent dark:bg-form-input">
                        <select
                            value={targetAction}
                            onChange={(e) => setTargetAction(e.target.value)}
                            className="relative z-20 w-full appearance-none rounded border border-stroke bg-transparent px-5 py-3 outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:focus:border-primary"
                        >
                            <option value="/home">Home Screen</option>
                            <option value="/contests">Contests Page</option>
                            <option value="/wallet">Wallet Page</option>
                            <option value="/profile">User Profile</option>
                            <option value="/settings">Settings</option>
                        </select>
                        <span className="absolute right-4 top-1/2 z-30 -translate-y-1/2">
                            <svg className="fill-current" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <g opacity="0.8">
                                <path fillRule="evenodd" clipRule="evenodd" d="M5.29289 8.29289C5.68342 7.90237 6.31658 7.90237 6.70711 8.29289L12 13.5858L17.2929 8.29289C17.6834 7.90237 18.3166 7.90237 18.7071 8.29289C19.0976 8.68342 19.0976 9.31658 18.7071 9.70711L12.7071 15.7071C12.3166 16.0976 11.6834 16.0976 11.2929 15.7071L5.29289 9.70711C4.90237 9.31658 4.90237 8.68342 5.29289 8.29289Z" fill="" />
                                </g>
                            </svg>
                        </span>
                    </div>
                </div>

                <div className="flex justify-end gap-4.5">
                  <button
                    disabled={sending}
                    className="flex justify-center rounded bg-primary px-10 py-3 font-medium text-gray hover:bg-opacity-90 disabled:bg-opacity-50"
                    type="submit"
                  >
                    {sending ? "Sending..." : activeTab === "broadcast" ? "SEND BROADCAST" : "SEND MESSAGE"}
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* Preview Section */}
          <div className="rounded-sm border border-stroke bg-white p-7 shadow-default dark:border-strokedark dark:bg-boxdark">
            <h4 className="mb-4 text-xl font-semibold text-black dark:text-white">Live Preview</h4>
            <div className="flex flex-col gap-6">
                
                {/* Mobile Lock Screen Preview */}
                <div>
                    <h5 className="mb-2 text-sm font-medium text-gray-500">Lock Screen</h5>
                    <div className="mx-auto w-full max-w-[320px] rounded-2xl border-4 border-black bg-gray-2 p-4 dark:bg-dark dark:border-white">
                        <div className="mb-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="h-5 w-5 rounded bg-primary flex items-center justify-center text-[10px] text-white font-bold">T</div>
                                <span className="text-[10px] font-bold uppercase text-gray-600 dark:text-gray-300">Tophunt • Now</span>
                            </div>
                        </div>
                        <div className="rounded-lg bg-white/80 p-3 shadow-sm backdrop-blur dark:bg-boxdark/80">
                            <p className="block text-sm font-bold text-black dark:text-white">{title || "Notification Title"}</p>
                            <p className="mt-1 block text-xs text-black dark:text-gray-300">{body || "This is how your message will appear on the user's lock screen."}</p>
                        </div>
                    </div>
                </div>

                {/* In-App Notification Preview */}
                <div>
                    <h5 className="mb-2 text-sm font-medium text-gray-500">In-App Notification Item</h5>
                    <div className="w-full rounded-lg border border-stroke bg-white p-4 dark:border-strokedark dark:bg-meta-4">
                         <div className="flex gap-4">
                            <div className="h-12 w-12 flex-shrink-0 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between">
                                    <h5 className="font-semibold text-black dark:text-white">{title || "Notification Title"}</h5>
                                    <span className="text-xs text-gray-500">Just now</span>
                                </div>
                                <p className="text-sm text-gray-600 dark:text-gray-400">{body || "This is how it looks in the notification list."}</p>
                            </div>
                            {imageUrl && (
                                <div className="h-12 w-12 rounded bg-gray-200 bg-cover bg-center" style={{backgroundImage: `url(${imageUrl})`}}></div>
                            )}
                         </div>
                    </div>
                </div>

            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default BroadcastPage;
