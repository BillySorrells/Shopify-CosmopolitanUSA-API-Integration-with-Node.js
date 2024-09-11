import { Link } from "react-router-dom";
import "./Main.css";

export const Layout = ({ children }) => {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="bg-primary-800 text-white p-4">
        <div className="container mx-auto px-4 py-2 flex justify-between">
          <Link to="/">
            <h1 className="text-xl2 font-semibold">cosmopolitanApi</h1>
          </Link>
          {/* Removed user greeting and logout functionality */}
        </div>
      </header>
      <main className="container mx-auto px-4 py-2 flex-grow">
        {children}
      </main>
      <footer>
        <div className="container mx-auto p-4">
          <p className="text-center text-gray-500 text-sm">
            cosmopolitanApi ~ Powered by Wasp
          </p>
        </div>
      </footer>
    </div>
  );
};
