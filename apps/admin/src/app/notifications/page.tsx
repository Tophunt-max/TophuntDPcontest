"use client";

import { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { toast } from "react-hot-toast";
import InputGroup from "@/components/FormElements/InputGroup";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "@/lib/firebase/config";

const BroadcastPage = () => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !body) {
      toast.error("Title and Message are required!");
      return;
    }

    const confirmSend = window.confirm(`Are you sure you want to send this broadcast to ALL users?`);
    if (!confirmSend) return;

    setSending(true);
    try {
      const functions = getFunctions(app);
      const sendBroadcast = httpsCallable(functions, "sendBroadcastNotification");
      
      const result: any = await sendBroadcast({
        title,
        body,
        imageUrl: imageUrl || null,
        targetPage: "/home"
      });

      if (result.data.success) {
        toast.success(`Successfully sent to ${result.data.sentCount} users!`);
        setTitle("");
        setBody("");
        setImageUrl("");
      } else {
        toast.error(result.data.message || "Something went wrong.");
      }
    } catch (error: any) {
      console.error(error);
      toast.error(error.message || "Failed to send broadcast.");
    } finally {
      setSending(false);
    }
  };

  return (
    <DefaultLayout>
      <div className="mx-auto max-w-270">
        <Breadcrumb pageName="Push Notifications (Broadcast)" />

        <div className="grid grid-cols-1 gap-8">
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-7 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white">Create New Broadcast</h3>
            </div>
            <div className="p-7">
              <form onSubmit={handleSend}>
                <div className="mb-6">
                  <InputGroup
                    label="Notification Title"
                    type="text"
                    placeholder="e.g. New Contest Live! 🔥"
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

                <div className="flex justify-end gap-4.5">
                  <button
                    disabled={sending}
                    className="flex justify-center rounded bg-primary px-10 py-3 font-medium text-gray hover:bg-opacity-90 disabled:bg-opacity-50"
                    type="submit"
                  >
                    {sending ? "Sending..." : "SEND BROADCAST NOW"}
                  </button>
                </div>
              </form>
            </div>
          </div>

          <div className="rounded-sm border border-stroke bg-white p-7 shadow-default dark:border-strokedark dark:bg-boxdark">
            <h4 className="mb-4 text-xl font-semibold text-black dark:text-white">Preview (On Mobile)</h4>
            <div className="mx-auto max-w-[300px] rounded-2xl border-4 border-black p-4 bg-gray-2 dark:bg-dark">
               <div className="mb-2 flex items-center gap-2">
                 <div className="h-6 w-6 rounded bg-primary"></div>
                 <span className="text-[10px] font-bold">TOPHUNT</span>
               </div>
               <div className="rounded-lg bg-white p-3 shadow dark:bg-boxdark">
                 <p className="block text-xs font-bold text-black dark:text-white">{title || "Notification Title"}</p>
                 <p className="mt-1 block text-[10px] text-gray-500">{body || "This is how your message will look on user's devices."}</p>
                 {imageUrl && <div className="mt-2 h-20 w-full rounded bg-gray-300" style={{backgroundImage: `url(${imageUrl})`, backgroundSize: 'cover'}}></div>}
               </div>
            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default BroadcastPage;
