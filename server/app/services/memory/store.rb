module Memory
  # The seam between WorkRoom and whatever holds the room's knowledge.
  # Callers never touch the backing store directly, so the local
  # implementation can be swapped for an external context database
  # without changing a single call site.
  class Store
    def self.current = @current ||= Local.new

    def self.current=(store)
      @current = store
    end

    def context_for(_channel, limit: 20)  = raise NotImplementedError
    def search(_channel, _query, limit: 10) = raise NotImplementedError
    def write(_channel, **_attrs)         = raise NotImplementedError
  end
end
