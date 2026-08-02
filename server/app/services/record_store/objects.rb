module RecordStore
  # Where a record's payload lives: unnamed bytes, addressed by what they are
  # rather than by where they were put. The journal that references them comes
  # later; this half only has to hand the same bytes back.
  #
  # There is no new backend and no new configuration. Active Storage is already
  # the right store per environment — Disk in development and test, the
  # S3-compatible bucket in production — and its services already verify an
  # upload's checksum and hold one object per key. What is missing is the
  # addressing, and that is all this class adds.
  class Objects
    # Bytes carry no channel and no name, so one instance serves the whole
    # process — unlike Memory::Store, which resolves per workspace because what
    # a room knows is a property of the room.
    def self.current = @current ||= new

    # The digest is the address. Callers keep it; nothing else identifies the
    # content, and identical content stored from two places is one object.
    def put(content)
      sha = Digest::SHA256.hexdigest(content)
      key = key_for(sha)
      return sha if service.exist?(key)

      bytes = StringIO.new(content.b)
      service.upload(key, bytes, checksum: OpenSSL::Digest::MD5.base64digest(content))
      sha
    end

    # nil rather than a backend's own exception: a caller asking for an address
    # it does not have should not have to know whether the answer arrives as
    # ActiveStorage::FileNotFoundError or as an S3 404.
    #
    # Asking first and downloading second is a race in the general case. Objects
    # are only ever created here, never deleted, so the window has nothing to
    # hold.
    def get(sha256)
      key = key_for(sha256)
      return nil unless service.exist?(key)

      service.download(key)
    end

    def exists?(sha256) = service.exist?(key_for(sha256))

    private
      # The algorithm is in the key because it will not always be SHA-256, and a
      # bucket of bare digests is a migration with nowhere to put the new ones.
      def key_for(sha256) = "record/sha256/#{sha256}"

      def service = ActiveStorage::Blob.service
  end
end
