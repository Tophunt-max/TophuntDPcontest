import { useState, useEffect, useRef } from "react";
import { callApi } from "@/services/firebase/functions";

interface UserSearchProps {
  label: string;
  onSelect: (userId: string) => void;
  selectedUserId?: string; // To handle reset
}

const UserSearch = ({ label, onSelect, selectedUserId }: UserSearchProps) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Handle outside click to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reset when parent clears selection
  useEffect(() => {
      if (!selectedUserId) {
          setQuery("");
          setSelectedUser(null);
      }
  }, [selectedUserId]);

  // Debounced Search
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (query.length < 2) {
          setResults([]);
          return;
      }
      
      // If query matches selected user, don't search again
      if (selectedUser && query === selectedUser.username) return;

      setLoading(true);
      try {
        const result: any = await callApi("searchUsers", { query });
        setResults(result.users || []);
        setShowDropdown(true);
      } catch (error) {
        console.error("Search failed", error);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [query]);

  const handleSelect = (user: any) => {
      setSelectedUser(user);
      setQuery(user.username);
      onSelect(user.id);
      setShowDropdown(false);
  };

  return (
    <div className="relative mb-6" ref={dropdownRef}>
      <label className="mb-2.5 block text-black dark:text-white">
        {label}
      </label>
      <div className="relative">
        <input
          type="text"
          placeholder="Type username to search..."
          value={query}
          onChange={(e) => {
              setQuery(e.target.value);
              // If user clears input, clear selection
              if(e.target.value === "") onSelect("");
          }}
          className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
        />
        
        {loading && (
             <div className="absolute right-4 top-4 h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        )}
      </div>

      {showDropdown && results.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
          {results.map((user) => (
            <div
              key={user.id}
              onClick={() => handleSelect(user)}
              className="flex cursor-pointer items-center gap-3 border-b border-stroke px-4 py-3 hover:bg-gray-2 dark:border-strokedark dark:hover:bg-meta-4"
            >
              <div className="h-10 w-10 overflow-hidden rounded-full bg-gray-200">
                  {user.avatar ? (
                      <img src={user.avatar} alt="User" className="h-full w-full object-cover" />
                  ) : (
                      <div className="flex h-full w-full items-center justify-center bg-primary text-white font-bold">
                          {user.username.charAt(0).toUpperCase()}
                      </div>
                  )}
              </div>
              <div>
                <p className="font-medium text-black dark:text-white">{user.username}</p>
                <p className="text-xs text-gray-500">{user.email || "No email"}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      
      {showDropdown && !loading && query.length >= 2 && results.length === 0 && (
           <div className="absolute z-50 mt-1 w-full rounded border border-stroke bg-white p-3 text-center text-sm text-gray-500 shadow-default dark:border-strokedark dark:bg-boxdark">
               No users found.
           </div>
      )}
    </div>
  );
};

export default UserSearch;
