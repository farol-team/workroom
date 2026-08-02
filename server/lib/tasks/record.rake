namespace :record do
  desc "Re-read a room's journal and prove the chain from the bytes — record:verify[slug], or every room"
  task :verify, [ :slug ] => :environment do |_task, args|
    slug = args[:slug]
    checked = 0
    broken = []

    # Every workspace, entered one at a time, because the boundary is the
    # database's: a connection that has entered nothing sees no rooms, and a
    # checker that reports success by finding nothing to check is worse than no
    # checker. It looks unnecessary from a psql that bypasses row-level
    # security, which is exactly the connection nobody should be trusting here.
    #
    # Wrapped in one transaction of its own: Workspace#entered puts the
    # previous scope back with SET LOCAL after its own transaction has closed,
    # which outside one is a no-op and a warning on every room. Read-only work,
    # so a single snapshot over all of it costs nothing and reads the record as
    # it stood at one moment.
    ActiveRecord::Base.transaction do
      Workspace.find_each do |workspace|
        workspace.entered do
          rooms = slug ? Array(Channel.find_by(slug:)) : Channel.order(:slug).to_a

          rooms.each do |room|
            checked += 1
            # Slugs are unique per workspace, not globally, so a bare slug
            # names as many rooms as there are workspaces holding one.
            label = "#{workspace.slug}/#{room.slug}"
            result = RecordStore::Verify.call(room)

            if result.ok?
              puts "#{label}: OK (#{result.entries} entries)"
            else
              broken << label
              result.failures.each { |failure| puts "#{label}: #{failure}" }
            end
          end
        end
      end
    end

    # Nonzero, because this is a check and a check nobody can wire into
    # anything is a report. `abort` prints to stderr and leaves the lines above
    # on stdout, so a pipe keeps the findings and the shell keeps the verdict.
    abort "no room anywhere is called #{slug}" if slug && checked.zero?
    abort "the record does not verify: #{broken.join(", ")}" if broken.any?
  end
end
