module Memory
  # What an agent is asked to confine itself to, in the prompt that opens its
  # session.
  #
  # A convention, not a control, and worth saying twice. The context store
  # isolates accounts and knows nothing of channels, so a key that reaches one
  # room reaches every room of its workspace — measured, in
  # docs/spikes/openviking-isolation.md. Nothing in this server may be written
  # as though this sentence stopped anything.
  #
  # What it is worth: it turns a silent reach into a deliberate one, and an
  # agent that ignores a boundary it was given is a thing worth seeing in a
  # transcript.
  module Boundary
    def self.for(channel)
      <<~TEXT.strip
        Your channel's memory is rooted at #{channel.memory_uri}
        Read and write only inside it. Other channels' memory is reachable with
        your key and is not yours to read.

        Write through the rail: workroom://memory/remember records a conclusion,
        workroom://memory/supersede corrects one. Writes made that way land in
        this channel's subtree with provenance and a journal record; the MCP
        tools are for reading and search. An entry may carry a .<name>.meta.json
        next to it — the server's journal lineage (seq, entry_hash) of the write
        that made it.
      TEXT
    end
  end
end
